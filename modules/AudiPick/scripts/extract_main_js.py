# -*- syntax check audipick inline script
from pathlib import Path
import re
html = Path(__file__).resolve().parent.parent / "audipick.html"
s = html.read_text(encoding="utf-8")
# extract last big script block
m = re.search(r"<script>\s*\n(?:var PDFJS_CFG|pdfjsLib)", s)
if not m:
    raise SystemExit("script not found")
start = m.start()
end = s.rfind("</script>")
js = s[s.index(">", start)+1:end]
# wrap as file for node
tmp = Path(__file__).parent / "_check.js"
tmp.write_text(js, encoding="utf-8")
print("extracted", len(js), "chars")
