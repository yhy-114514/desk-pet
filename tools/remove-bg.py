"""批量抠图：白底图片 -> 透明 PNG（rembg / isnet-anime）。

用法: python tools/remove-bg.py <src_dir> <out_dir>
首次运行会自动下载 isnet-anime 模型（约 176MB）到 ~/.u2net。
"""

import sys
from pathlib import Path

import numpy as np
from rembg import new_session, remove
from PIL import Image
from scipy import ndimage

SUPPORTED = {".jpg", ".jpeg", ".png", ".webp"}


# 空隙判据：isnet-anime 会把「头发/身体之间的白底空隙」误判为主体，留下不透明白块。
# 空隙是画幅里那层纯白背景（亮度约 249），而白围裙/白袜/蕾丝带明暗渐变（均值约 235-243），
# 因此用「白色连通块的亮度均值」区分：够亮且足够大 = 背景空隙。
GAP_MEAN_LUM = 244
MIN_GAP_PIXELS = 40


def clear_background_whites(img: Image.Image, matted: Image.Image) -> Image.Image:
    """把与画幅外框连通的白色、以及被头发/身体包围的平坦白色空隙置透明。"""
    rgb = np.asarray(img.convert("RGB"))
    lo = rgb.min(axis=2)
    hi = rgb.max(axis=2)
    white = (lo > 228) & ((hi - lo) < 14)
    labels, count = ndimage.label(white, structure=np.ones((3, 3)))
    if count == 0:
        return matted

    lum = rgb.mean(axis=2)
    flat_labels = labels.ravel()
    sizes = np.bincount(flat_labels, minlength=count + 1)
    sums = np.bincount(flat_labels, weights=lum.ravel(), minlength=count + 1)
    means = sums / np.maximum(sizes, 1)

    # 贴画幅四条边的白色连通块 = 外部白底
    border = set(
        np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])).tolist()
    )
    border.discard(0)
    gaps = [
        label
        for label in range(1, count + 1)
        if label not in border and sizes[label] >= MIN_GAP_PIXELS and means[label] >= GAP_MEAN_LUM
    ]
    if not gaps and not border:
        return matted

    out = np.array(matted)
    out[np.isin(labels, list(border) + gaps), 3] = 0
    return Image.fromarray(out)


def main() -> int:
    if len(sys.argv) != 3:
        print("用法: python tools/remove-bg.py <src_dir> <out_dir>")
        return 1

    src_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(p for p in src_dir.iterdir() if p.suffix.lower() in SUPPORTED)
    if not files:
        print(f"未找到源图: {src_dir}")
        return 1

    # 复用 session，模型只加载一次。isnet-anime 是动漫/卡通角色专用分割模型，
    # 对 Q 版角色的发丝与发间空隙分割明显优于通用 u2net。
    session = new_session("isnet-anime")
    for src in files:
        out = out_dir / f"{src.stem}.png"
        with Image.open(src) as img:
            rgb = img.convert("RGB")
            result = clear_background_whites(rgb, remove(rgb, session=session))
        result.save(out)
        print(f"抠图完成: {src.name} -> {out.name}")

    print(f"共处理 {len(files)} 张")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
