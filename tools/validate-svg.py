"""校验生成的 SVG 战报：格式良构性、元素越界、文本溢出。

用法: python tools/validate-svg.py <path.svg>

为什么需要这个脚本：SVG 不会像 HTML 那样自动换行或裁剪，一个坐标算错就会
文字压边或跑出画布，肉眼不看图很难发现。这里用几何检查兜住这类低级错误。
"""
import sys

from lxml import etree

SVG_NS = "http://www.w3.org/2000/svg"


def display_width(text):
    """CJK 记 2 个单位，其余记 1"""
    width = 0
    for ch in text or "":
        code = ord(ch)
        wide = (
            0x1100 <= code <= 0x115F
            or 0x2E80 <= code <= 0xA4CF
            or 0xAC00 <= code <= 0xD7A3
            or 0xF900 <= code <= 0xFAFF
            or 0xFE30 <= code <= 0xFE4F
            or 0xFF00 <= code <= 0xFF60
            or 0xFFE0 <= code <= 0xFFE6
        )
        width += 2 if wide else 1
    return width


def main(path):
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    tree = etree.parse(path, parser)
    root = tree.getroot()

    width = float(root.get("width"))
    height = float(root.get("height"))
    print(f"画布: {width:.0f} x {height:.0f}")
    print(f"根元素: {root.tag}")

    problems = []

    texts = root.findall(f".//{{{SVG_NS}}}text")
    print(f"文本元素: {len(texts)}")
    for node in texts:
        content = "".join(node.itertext())
        size = float(node.get("font-size", "14"))
        x = float(node.get("x", "0"))
        y = float(node.get("y", "0"))
        anchor = node.get("text-anchor", "start")
        est = display_width(content) * size * 0.5 * (2 if False else 1)
        # CJK 约 1.0em/字，ASCII 约 0.5em/字：这里按 0.55em 的混合估计
        est = display_width(content) * size * 0.55
        if anchor == "middle":
            left, right = x - est / 2, x + est / 2
        elif anchor == "end":
            left, right = x - est, x
        else:
            left, right = x, x + est
        if right > width - 4:
            problems.append(f"右溢出: x={x:.0f} right≈{right:.0f} > {width:.0f} :: {content[:40]}")
        if left < 2:
            problems.append(f"左溢出: x={x:.0f} left≈{left:.0f} :: {content[:40]}")
        if y < 8 or y > height - 2:
            problems.append(f"纵向越界: y={y:.0f} :: {content[:40]}")

    rects = root.findall(f".//{{{SVG_NS}}}rect")
    for node in rects:
        x = float(node.get("x", "0"))
        y = float(node.get("y", "0"))
        w = float(node.get("width", "0"))
        h = float(node.get("height", "0"))
        if x < -1 or y < -1 or x + w > width + 1 or y + h > height + 1:
            problems.append(f"矩形越界: x={x:.0f} y={y:.0f} w={w:.0f} h={h:.0f}")

    print(f"矩形元素: {len(rects)}")
    print(f"圆形元素: {len(root.findall(f'.//{{{SVG_NS}}}circle'))}")
    print(f"线条元素: {len(root.findall(f'.//{{{SVG_NS}}}line'))}")

    if problems:
        print(f"\n发现 {len(problems)} 个问题:")
        for item in problems[:40]:
            print("  - " + item)
        return 1

    print("\nOK: 无越界或溢出问题")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
