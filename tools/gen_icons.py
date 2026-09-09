#!/usr/bin/env python3
"""生成占位图标（纯标准库 PNG 写入，无需 PIL）。
样式：哔哩蓝底 + 白色圆形（'收藏' 圆点语义），上架前替换为正式图标即可。"""
import os
import struct
import zlib

OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'extension', 'icons'))
os.makedirs(OUT, exist_ok=True)

BLUE = (0, 161, 214, 255)
WHITE = (255, 255, 255, 255)


def png_chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data +
            struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))


def make_png(size, path):
    cx = cy = (size - 1) / 2.0
    r = size * 0.36
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            dx, dy = x - cx, y - cy
            inside = dx * dx + dy * dy <= r * r
            px = WHITE if inside else BLUE
            row += bytes(px)
        rows.append(bytes(row))
    raw = b''.join(rows)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', ihdr) +
           png_chunk(b'IDAT', zlib.compress(raw, 9)) +
           png_chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print('written', path)


for size in (16, 48, 128):
    make_png(size, os.path.join(OUT, 'icon%d.png' % size))
