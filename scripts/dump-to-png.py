# Converts a raw BGRA dump from native/test/syphon-probe into a PNG (development helper).
import struct, sys, zlib

def main(src, dst):
    data = open(src, 'rb').read()
    w, h, bpr = struct.unpack('<III', data[:12])
    px = data[12:]
    rows = []
    for y in range(h):
        row = px[y * bpr: y * bpr + w * 4]
        out = bytearray(w * 4)
        out[0::4] = row[2::4]
        out[1::4] = row[1::4]
        out[2::4] = row[0::4]
        out[3::4] = row[3::4]
        rows.append(b'\x00' + bytes(out))
    raw = zlib.compress(b''.join(rows), 6)
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')
    open(dst, 'wb').write(png)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
