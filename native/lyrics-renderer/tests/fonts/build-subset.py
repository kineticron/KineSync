"""Rebuild the test-only CFF collection using fontTools 4.68.0 and Noto CJK 2.004."""
from pathlib import Path
import sys
from fontTools import subset
from fontTools.ttLib import TTFont, TTCollection

out = Path(__file__).parent
collection = TTCollection()
collection.fonts = []
for source, style in zip(sys.argv[1:], ["Regular", "Bold"], strict=True):
    font = TTFont(source, fontNumber=0, recalcTimestamp=False)
    options = subset.Options()
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
    sub = subset.Subsetter(options=options)
    sub.populate(text="革命道中君夢愛爱漢汉語语한국어")
    sub.subset(font)
    names = {1: "KineSync CJK Test", 2: style, 3: f"KineSync CJK Test {style}",
             4: f"KineSync CJK Test {style}", 6: f"KineSyncCJKTest-{style}",
             16: "KineSync CJK Test", 17: style}
    for record in font["name"].names:
        if record.nameID in names:
            record.string = names[record.nameID].encode(record.getEncoding())
    collection.fonts.append(font)
assert len(collection.fonts) == 2, "Pass regular and bold TTC source paths"
collection.save(out / "cjk-subset.ttc")
