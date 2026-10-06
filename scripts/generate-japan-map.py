#!/usr/bin/env python3
"""Convert JMA's earthquake prefecture Shapefile into a compact local SVG.

Usage: python3 scripts/generate-japan-map.py /path/to/JMA_GIS.zip
Only Python's standard library is used. This script is a build-time utility;
the browser loads only the generated SVG.
"""

from __future__ import annotations

import json
import math
import mmap
import shutil
import struct
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "src/mapProjectionConfig.json").read_text())
OUTPUT = ROOT / "src/assets/japan-map.svg"


def dbf_records(path: Path) -> list[tuple[str, str]]:
    data = path.read_bytes()
    row_count = struct.unpack_from("<I", data, 4)[0]
    header_size, record_size = struct.unpack_from("<HH", data, 8)
    fields = []
    offset = 32
    while data[offset] != 13:
        name = data[offset : offset + 11].split(b"\0", 1)[0].decode("ascii")
        fields.append((name, data[offset + 11], data[offset + 16]))
        offset += 32

    records = []
    for row_index in range(row_count):
        offset = header_size + row_index * record_size
        row = data[offset : offset + record_size]
        if row[:1] == b"*":
            continue
        values: dict[str, str] = {}
        field_offset = 1
        for name, _kind, width in fields:
            values[name] = row[field_offset : field_offset + width].decode("utf-8").strip()
            field_offset += width
        records.append((values["code"].zfill(2), values["name"]))
    return records


def projected(point: tuple[float, float], center_lon: float, center_lat: float, scale: float, size: float) -> tuple[float, float]:
    longitude, latitude = point
    return (
        size / 2 + (longitude - center_lon) * math.cos(math.radians(center_lat)) * scale,
        size / 2 - (latitude - center_lat) * scale,
    )


def distance_to_segment_sq(point: tuple[float, float], start: tuple[float, float], end: tuple[float, float]) -> float:
    dx, dy = end[0] - start[0], end[1] - start[1]
    if dx == 0 and dy == 0:
        return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2
    fraction = max(0.0, min(1.0, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)))
    x, y = start[0] + fraction * dx, start[1] + fraction * dy
    return (point[0] - x) ** 2 + (point[1] - y) ** 2


def simplify_open(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    if len(points) <= 2:
        return points

    # Radial prefilter limits work on the densely sampled source coastline.
    sparse = [points[0]]
    for point in points[1:-1]:
        if (point[0] - sparse[-1][0]) ** 2 + (point[1] - sparse[-1][1]) ** 2 >= tolerance * tolerance:
            sparse.append(point)
    sparse.append(points[-1])
    if len(sparse) <= 2:
        return sparse

    keep = {0, len(sparse) - 1}
    pending = [(0, len(sparse) - 1)]
    tolerance_sq = tolerance * tolerance
    while pending:
        first, last = pending.pop()
        maximum, index = tolerance_sq, -1
        for candidate in range(first + 1, last):
            distance = distance_to_segment_sq(sparse[candidate], sparse[first], sparse[last])
            if distance > maximum:
                maximum, index = distance, candidate
        if index >= 0:
            keep.add(index)
            pending.append((first, index))
            pending.append((index, last))
    return [point for index, point in enumerate(sparse) if index in keep]


def simplify_ring(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    if len(points) < 5 or points[0] != points[-1]:
        return points
    core = points[:-1]
    if len(core) <= 4:
        return points

    # Split the closed ring at its point farthest from the first vertex, then
    # simplify both open arcs. This keeps closure and avoids a degenerate chord.
    anchor = core[0]
    split = max(range(1, len(core)), key=lambda index: (core[index][0] - anchor[0]) ** 2 + (core[index][1] - anchor[1]) ** 2)
    first_arc = simplify_open(core[: split + 1], tolerance)
    second_arc = simplify_open(core[split:] + [anchor], tolerance)
    simplified = first_arc[:-1] + second_arc[:-1]
    if len(simplified) < 3:
        # Keep sub-pixel islands recognizable without carrying every source
        # coastline vertex; their exact shape is below the output resolution.
        xs, ys = [point[0] for point in core], [point[1] for point in core]
        center_x, center_y = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        radius_x = max((max(xs) - min(xs)) / 2, 0.3)
        radius_y = max((max(ys) - min(ys)) / 2, 0.3)
        return [
            (center_x, center_y - radius_y),
            (center_x + radius_x, center_y),
            (center_x, center_y + radius_y),
            (center_x - radius_x, center_y),
            (center_x, center_y - radius_y),
        ]
    return simplified + [simplified[0]]


def path_data(points: list[tuple[float, float]]) -> str:
    commands = []
    for index, point in enumerate(points):
        command = "M" if index == 0 else ""
        commands.append(f"{command}{point[0]:.1f},{point[1]:.1f}")
    commands.append("Z")
    return " ".join(commands)


def convert(shp_path: Path, dbf_path: Path) -> None:
    prefectures = dbf_records(dbf_path)
    size = float(CONFIG["viewBoxSize"])
    min_lon, max_lon = CONFIG["minLongitude"], CONFIG["maxLongitude"]
    min_lat, max_lat = CONFIG["minLatitude"], CONFIG["maxLatitude"]
    center_lon, center_lat = (min_lon + max_lon) / 2, (min_lat + max_lat) / 2
    longitude_span = (max_lon - min_lon) * math.cos(math.radians(center_lat))
    latitude_span = max_lat - min_lat
    scale = (size - 2 * CONFIG["padding"]) / max(longitude_span, latitude_span)
    tolerance = CONFIG["simplificationToleranceDegrees"] * scale

    elements = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size:g} {size:g}" role="img" aria-labelledby="map-title map-description">',
        '<title id="map-title">日本の都道府県地図</title>',
        '<desc id="map-description">気象庁「地震情報／都道府県等」の地理データを簡略化して作成した地図です。</desc>',
        '<g fill="#102638" stroke="#426b89" stroke-width="1.15" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke">',
    ]

    with shp_path.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        offset = 100
        feature_index = 0
        while offset < len(data):
            _record_number, content_words = struct.unpack_from(">ii", data, offset)
            start = offset + 8
            shape_type = struct.unpack_from("<i", data, start)[0]
            if shape_type != 5:
                raise ValueError(f"Expected Polygon (5), found shape type {shape_type}")
            part_count, point_count = struct.unpack_from("<ii", data, start + 36)
            part_offset = start + 44
            parts = struct.unpack_from(f"<{part_count}i", data, part_offset)
            point_offset = part_offset + part_count * 4
            code, name = prefectures[feature_index]
            path_segments = []
            for part_index, ring_start in enumerate(parts):
                ring_end = parts[part_index + 1] if part_index + 1 < part_count else point_count
                geographic = [struct.unpack_from("<2d", data, point_offset + point_index * 16) for point_index in range(ring_start, ring_end)]
                raw = [projected(point, center_lon, center_lat, scale, size) for point in geographic]
                if len(raw) < 4:
                    continue
                width = max(point[0] for point in raw) - min(point[0] for point in raw)
                height = max(point[1] for point in raw) - min(point[1] for point in raw)
                if max(width, height) < 1:
                    # Individual sub-pixel islands cannot be read at this map
                    # scale. Omitting them keeps the overview useful and small.
                    continue
                simplified = simplify_ring(raw, tolerance)
                path_segments.append(path_data(simplified))
            elements.append(f'<path id="pref-{code}" data-pref-code="{code}" data-pref-name="{escape(name, {chr(34): "&quot;"})}" fill-rule="evenodd" d="{" ".join(path_segments)}"/>')
            feature_index += 1
            offset = start + content_words * 2

    if feature_index != 47:
        raise ValueError(f"Expected 47 prefecture shapes, found {feature_index}")
    elements.extend(["</g>", "</svg>"])
    OUTPUT.write_text("\n".join(elements) + "\n")
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size:,} bytes), {feature_index} prefectures")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    source_zip = Path(sys.argv[1])
    with zipfile.ZipFile(source_zip) as archive, tempfile.TemporaryDirectory(prefix="jma-map-") as folder:
        shp_info = next(item for item in archive.infolist() if item.filename.lower().endswith(".shp"))
        dbf_info = next(item for item in archive.infolist() if item.filename.lower().endswith(".dbf"))
        shp_path, dbf_path = Path(folder) / "prefecture.shp", Path(folder) / "prefecture.dbf"
        with archive.open(shp_info) as source, shp_path.open("wb") as target:
            shutil.copyfileobj(source, target)
        with archive.open(dbf_info) as source, dbf_path.open("wb") as target:
            shutil.copyfileobj(source, target)
        convert(shp_path, dbf_path)


if __name__ == "__main__":
    main()
