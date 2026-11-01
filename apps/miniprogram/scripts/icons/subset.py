# Builds icons.woff, the part of TDesign's icon font the mini program uses, so icons need no
# download from tdesign.gtimg.com. prepare.mjs embeds it and lists any icon missing from it.
# Usage, after `pnpm --filter @rs/miniprogram build`:
#   python3 -m pip install fonttools && python3 scripts/icons/subset.py <t.woff>
# where t.woff is lib/iconfont/t.woff of the tdesign-icons-web-components npm package, the font
# tdesign-miniprogram loads. Code points come from tdesign-miniprogram's own icon.wxss.
import json
import re
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

here = Path(__file__).parent
names = json.loads((here / 'icons.json').read_text())
wxss = here.parent.parent / 'miniprogram/miniprogram_npm/tdesign-miniprogram/icon/icon.wxss'
by_name = {
    name: int(code, 16)
    for name, code in re.findall(r"\.t-icon-([a-z0-9-]+):before\{content:'\\([0-9A-F]+)';\}", wxss.read_text())
}
missing = [n for n in names if n not in by_name]
if missing:
    sys.exit(f'not TDesign icons: {", ".join(missing)}')
font = TTFont(sys.argv[1])
options = subset.Options()
options.flavor = 'woff'
options.layout_features = []
subsetter = subset.Subsetter(options)
subsetter.populate(unicodes=[by_name[n] for n in names])
subsetter.subset(font)
font.flavor = 'woff'
font.save(here / 'icons.woff')
print(f'{len(names)} icons, {(here / "icons.woff").stat().st_size} bytes')
