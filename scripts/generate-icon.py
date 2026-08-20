from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIRECTORY = ROOT / "build"
CANVAS_SIZE = 1024


def create_icon() -> Image.Image:
    # Vẽ ở độ phân giải lớn để các kích thước icon Windows vẫn sắc nét.
    image = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle((84, 96, 940, 952), radius=210, fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(42))
    image.alpha_composite(shadow)

    background = Image.new("RGBA", image.size, (0, 0, 0, 0))
    background_draw = ImageDraw.Draw(background)
    for y in range(76, 932):
        ratio = (y - 76) / 856
        color = (
            round(37 + 9 * ratio),
            round(34 + 6 * ratio),
            round(28 + 2 * ratio),
            255,
        )
        background_draw.line((82, y, 942, y), fill=color, width=1)

    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((82, 76, 942, 936), radius=210, fill=255)
    image.alpha_composite(Image.composite(background, Image.new("RGBA", image.size), mask))

    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((82, 76, 942, 936), radius=210, outline=(229, 182, 104, 230), width=22)

    # Biểu tượng cuốn sách mở gợi đúng chức năng sáng tác và điều phối câu chuyện.
    left_page = [(226, 326), (492, 386), (492, 746), (226, 686)]
    right_page = [(532, 386), (798, 326), (798, 686), (532, 746)]
    draw.polygon(left_page, fill=(238, 223, 194, 255))
    draw.polygon(right_page, fill=(225, 202, 161, 255))
    draw.line(left_page + [left_page[0]], fill=(238, 190, 110, 255), width=18, joint="curve")
    draw.line(right_page + [right_page[0]], fill=(238, 190, 110, 255), width=18, joint="curve")
    draw.line((512, 390, 512, 754), fill=(191, 139, 70, 255), width=18)

    for offset in (0, 68, 136):
        draw.line((286, 432 + offset, 438, 466 + offset), fill=(100, 80, 56, 150), width=15)
        draw.line((586, 466 + offset, 738, 432 + offset), fill=(100, 80, 56, 140), width=15)

    # Ngôi sao ở tâm đại diện cho trợ lý AI nhưng vẫn giữ vẻ biên tập trang nhã.
    star = [(512, 196), (535, 256), (598, 276), (538, 298), (512, 360), (486, 298), (426, 276), (489, 256)]
    draw.polygon(star, fill=(242, 194, 112, 255))
    draw.ellipse((482, 246, 542, 306), fill=(255, 233, 179, 255))
    return image


def main() -> None:
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    icon = create_icon()
    icon.save(OUTPUT_DIRECTORY / "icon.png", format="PNG", optimize=True)
    icon.save(
        OUTPUT_DIRECTORY / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
