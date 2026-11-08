"""Generate the deterministic oriented JPEG for the Android codec probe."""

import argparse
from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    args = parser.parse_args()
    width, height = 4000, 3000
    tile = bytes(v for y in range(256) for x in range(256) for v in (x, y, x ^ y))
    tile = Image.frombytes("RGB", (256, 256), tile)
    image = Image.new("RGB", (width, height))
    for x in range(0, width, 256):
        for y in range(0, height, 256):
            image.paste(tile, (x, y))
    exif = Image.Exif()
    exif[274] = 6
    image.save(args.output, quality=92, exif=exif)


if __name__ == "__main__":
    main()
