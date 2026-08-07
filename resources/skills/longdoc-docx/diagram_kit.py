"""matplotlib 架构图/流程图通用工具箱（中文可用）。

不用画图工具手绘，用脚本画方框和箭头：改文字就是改字符串；配色字体统一由
常量控制；图表能进 git diff，方便 review 措辞变更。

用法：在你自己的 gen_diagrams.py 里
    import sys, os
    sys.path.insert(0, "<skill_dir>")
    from diagram_kit import box, arrow, new_fig, save, row_layout, NAVY, RED

    def diagram_architecture():
        fig, ax = new_fig(13, 9.2)
        box(ax, 0.5, 8.0, 12, 0.8, "接入层")
        ...
        save(fig, "diagram1-总体技术架构图.png", out_dir=OUT_DIR)

自检字体：
    python3 diagram_kit.py --check-font
"""
import os
import sys

import matplotlib
matplotlib.use("Agg")  # 无显示环境必须
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

# ---------------------------------------------------------------------------
# 中文字体：matplotlib 默认字体不含中文字形，必须显式指定字体文件
# 按优先级探测；找不到时报错并给出安装提示，而不是静默输出方块字
# ---------------------------------------------------------------------------

FONT_CANDIDATES = [
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
     "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-VF.otf.ttc",
     "/usr/share/fonts/opentype/noto/NotoSansCJK-VF.otf.ttc"),
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
     "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
    ("/System/Library/Fonts/PingFang.ttc",
     "/System/Library/Fonts/PingFang.ttc"),
    ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc"),
]

FONT_HINT = (
    "未找到中文字体，图中中文会渲染成方块。安装：\n"
    "  Debian/Ubuntu: apt-get install fonts-noto-cjk\n"
    "  RHEL/CentOS:   yum install google-noto-sans-cjk-ttc-fonts\n"
    "确认：fc-list | grep -i 'noto sans cjk'\n"
    "也可设环境变量 CJK_FONT_REGULAR / CJK_FONT_BOLD 指向字体文件。"
)


def _resolve_fonts():
    reg = os.environ.get("CJK_FONT_REGULAR")
    bold = os.environ.get("CJK_FONT_BOLD", reg)
    if reg and os.path.exists(reg):
        return reg, (bold if bold and os.path.exists(bold) else reg)
    for r, b in FONT_CANDIDATES:
        if os.path.exists(r):
            return r, (b if os.path.exists(b) else r)
    return None, None


FONT_PATH, FONT_PATH_BOLD = _resolve_fonts()
if FONT_PATH is None:
    print("WARN: " + FONT_HINT, file=sys.stderr)
    zh_font = fm.FontProperties()
    zh_bold = fm.FontProperties(weight="bold")
else:
    zh_font = fm.FontProperties(fname=FONT_PATH)
    zh_bold = fm.FontProperties(fname=FONT_PATH_BOLD)

# ---------------------------------------------------------------------------
# 配色：中文商务文档惯例（藏青主色 + 红色强调 + 灰阶）
# 换主题只改这几个常量，所有图一起变
# ---------------------------------------------------------------------------

NAVY = "#1F3864"
NAVY_LIGHT = "#DCE6F1"
RED = "#C00000"
RED_LIGHT = "#FBE4E4"
GRAY = "#595959"
GRAY_LIGHT = "#F2F2F2"
WHITE = "#FFFFFF"
TEXT = "#1a1a1a"


def box(ax, x, y, w, h, text, fc=WHITE, ec=NAVY, lw=1.4, fontsize=10.5,
        font=None, textcolor=TEXT,
        boxstyle="round,pad=0.02,rounding_size=0.06", zorder=2):
    """圆角方框 + 居中文字。linespacing 保证多行文字换行后不挤在一起。"""
    b = FancyBboxPatch((x, y), w, h, boxstyle=boxstyle, linewidth=lw,
                       edgecolor=ec, facecolor=fc, zorder=zorder)
    ax.add_patch(b)
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center",
            fontsize=fontsize, fontproperties=font or zh_font,
            color=textcolor, zorder=zorder + 1, linespacing=1.4)
    return b


def arrow(ax, xy_from, xy_to, color=GRAY, lw=1.6, style="-|>",
          connectionstyle="arc3,rad=0.0", zorder=3):
    a = FancyArrowPatch(xy_from, xy_to, arrowstyle=style, mutation_scale=14,
                        linewidth=lw, color=color,
                        connectionstyle=connectionstyle, zorder=zorder)
    ax.add_patch(a)
    return a


def label(ax, x, y, text, fontsize=9.5, color=GRAY, ha="center", va="center",
          font=None, zorder=4):
    """箭头旁的说明文字、图内小标注。"""
    return ax.text(x, y, text, ha=ha, va=va, fontsize=fontsize,
                   fontproperties=font or zh_font, color=color, zorder=zorder)


def new_fig(w, h, dpi=200):
    """画布坐标系直接等于英寸尺寸，摆位时按网格心算即可。dpi=200 保证放大不糊。"""
    fig, ax = plt.subplots(figsize=(w, h), dpi=dpi)
    ax.set_xlim(0, w)
    ax.set_ylim(0, h)
    ax.axis("off")
    return fig, ax


def save(fig, name, out_dir="."):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name)
    fig.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("saved:", path)
    return path


def row_layout(n, start_x, total_w, gap=0.25):
    """横向等宽切分：返回 n 个 (x, width)，用于并列分支摆放。

        for (x, w), g in zip(row_layout(len(groups), 0.5, 12.0), groups):
            box(ax, x, y0, w, h, g)
    """
    w = (total_w - gap * (n - 1)) / n
    return [(start_x + i * (w + gap), w) for i in range(n)]


def col_layout(n, top_y, total_h, gap=0.2):
    """纵向等高切分：返回 n 个 (y, height)，自上而下。"""
    h = (total_h - gap * (n - 1)) / n
    return [(top_y - h - i * (h + gap), h) for i in range(n)]


def _check_font():
    if FONT_PATH is None:
        print("中文字体：未找到\n" + FONT_HINT)
        return 1
    print(f"中文字体：{FONT_PATH}")
    print(f"粗体：    {FONT_PATH_BOLD}")
    fig, ax = new_fig(6, 2)
    box(ax, 0.3, 0.5, 5.4, 1.0, "中文字体自检 CJK Font OK 123")
    out = save(fig, "font_check.png", out_dir="/tmp")
    print(f"已生成 {out}，打开确认中文不是方块。")
    return 0


if __name__ == "__main__":
    if "--check-font" in sys.argv:
        sys.exit(_check_font())
    print(__doc__)
