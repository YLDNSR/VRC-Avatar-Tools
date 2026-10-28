# Generates build/icon.png (1024x1024): gradient rounded square with a person silhouette.
import math, struct, zlib, sys

N = 1024
def lerp(a, b, t): return a + (b - a) * t
c1 = (108, 140, 255); c2 = (139, 108, 255)
px = bytearray(N * N * 4)
R = 220  # corner radius
for y in range(N):
    for x in range(N):
        # rounded-rect mask with 1px antialiasing
        m = 92; dx = max(m + R - x, 0, x - (N - m - R)); dy = max(m + R - y, 0, y - (N - m - R))
        d = math.hypot(dx, dy) - R if (dx > 0 and dy > 0) else max(m - x, x - (N - 1 - m), m - y, y - (N - 1 - m))
        a = max(0.0, min(1.0, 0.5 - d))
        if a <= 0: continue
        t = (x + y) / (2 * N)
        r, g, b = (lerp(c1[i], c2[i], t) for i in range(3))
        # head
        hd = math.hypot(x - 512, y - 400) - 150
        # body (ellipse top half)
        bx = (x - 512) / 290; by = (y - 820) / 250
        bd = (math.sqrt(bx * bx + by * by) - 1) * 250 if y < 820 else 999
        bd = bd if y > 600 else 999
        s = max(0.0, min(1.0, 0.5 - min(hd, bd)))
        r = lerp(r, 255, s * 0.95); g = lerp(g, 255, s * 0.95); b = lerp(b, 255, s * 0.95)
        i = (y * N + x) * 4
        px[i:i + 4] = bytes((int(r), int(g), int(b), int(a * 255)))
raw = b''.join(b'\x00' + bytes(px[y * N * 4:(y + 1) * N * 4]) for y in range(N))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
open(sys.argv[1], 'wb').write(png)
