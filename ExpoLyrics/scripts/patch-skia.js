/**
 * ponytail: patches @shopify/react-native-skia Container.native to create
 * an empty picture via PictureRecorder instead of MakePicture(null), which
 * crashes on RN 0.81+ new architecture JSI bindings.
 */
const fs = require("fs");
const path = require("path");

const targets = [
  {
    file: path.join(
      __dirname,
      "..",
      "node_modules",
      "@shopify",
      "react-native-skia",
      "lib",
      "module",
      "sksg",
      "Container.native.js",
    ),
    find: "this.picture = Skia.Picture.MakePicture(new ArrayBuffer(0));",
    fallbackFind: "this.picture = Skia.Picture.MakePicture(null);",
    replace:
      "const _rec = Skia.PictureRecorder(); _rec.beginRecording(); this.picture = _rec.finishRecordingAsPicture();",
  },
  {
    file: path.join(
      __dirname,
      "..",
      "node_modules",
      "@shopify",
      "react-native-skia",
      "src",
      "sksg",
      "Container.native.ts",
    ),
    find: "this.picture = Skia.Picture.MakePicture(new ArrayBuffer(0))!;",
    fallbackFind: "this.picture = Skia.Picture.MakePicture(null)!;",
    replace:
      "const _rec = Skia.PictureRecorder(); _rec.beginRecording(); this.picture = _rec.finishRecordingAsPicture();",
  },
];

let patched = 0;
for (const { file, find, fallbackFind, replace } of targets) {
  if (!fs.existsSync(file)) continue;
  let content = fs.readFileSync(file, "utf8");
  if (content.includes(find)) {
    content = content.replace(find, replace);
    fs.writeFileSync(file, content, "utf8");
    patched++;
    console.log(`[skia-patch] Patched ${path.basename(file)}`);
  } else if (content.includes(fallbackFind)) {
    content = content.replace(fallbackFind, replace);
    fs.writeFileSync(file, content, "utf8");
    patched++;
    console.log(`[skia-patch] Patched ${path.basename(file)} (from null)`);
  } else if (content.includes(replace)) {
    console.log(`[skia-patch] ${path.basename(file)} already patched.`);
  } else {
    console.log(`[skia-patch] WARNING: Could not find target in ${path.basename(file)}`);
  }
}

if (patched === 0) {
  console.log("[skia-patch] No files needed patching.");
}
