from pathlib import Path
from math import cos, pi, sin

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIRECTORY = ROOT / "build"
CANVAS_SIZE = 1024


def atlas_point(x: float, y: float) -> tuple[int, int]:
    """Ánh xạ lưới biểu tượng 24×24 sang canvas icon Windows."""
    origin_x = 174
    origin_y = 170
    scale = 28
    return round(origin_x + x * scale), round(origin_y + y * scale)


def feather_outline() -> list[tuple[int, int]]:
    """Lấy mẫu cung lông vũ để đường viền vẫn mượt ở các kích thước nhỏ."""
    points: list[tuple[int, int]] = []
    center_x, center_y, radius = 16, 8, 6
    for step in range(25):
        angle = (45 - step * 180 / 24) * pi / 180
        points.append(atlas_point(center_x + radius * cos(angle), center_y + radius * sin(angle)))
    points.extend([atlas_point(5, 10.5), atlas_point(5, 19), atlas_point(13.5, 19), points[0]])
    return points


def create_icon() -> Image.Image:
    # Vẽ ở độ phân giải lớn để các kích thước icon Windows vẫn sắc nét.
    image = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((76, 76, 948, 948), radius=210, fill=(6, 23, 37, 255), outline=(19, 60, 78, 255), width=22)

    # Lông vũ cyan là dấu hiệu nhận diện chính của Storyworld Atlas.
    feather_color = (70, 168, 200, 255)
    stroke_width = 43
    draw.line(feather_outline(), fill=feather_color, width=stroke_width, joint="curve")
    draw.line((atlas_point(16, 8), atlas_point(2, 22)), fill=feather_color, width=stroke_width)
    draw.line((atlas_point(17.5, 15), atlas_point(9, 15)), fill=feather_color, width=stroke_width)

    # Đầu nét tròn giúp biểu tượng không bị gãy khi Windows thu xuống 16px.
    radius = stroke_width // 2
    for point in (atlas_point(20.24, 12.24), atlas_point(16, 8), atlas_point(2, 22), atlas_point(17.5, 15), atlas_point(9, 15)):
        draw.ellipse((point[0] - radius, point[1] - radius, point[0] + radius, point[1] + radius), fill=feather_color)
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
