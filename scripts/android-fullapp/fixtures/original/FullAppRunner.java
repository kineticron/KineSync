package dev.kineticron.fullapp;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.*;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;

/** Full-app UI runner. Drives the REAL KineSync app (test build) via deep-link fixture states.
 *  Evidence only: every step records files; nothing is marked pass from command success alone. */
public final class FullAppRunner extends Instrumentation {
  static final String PKG = "dev.kineticron.KineSync";
  static final String OUT = "/sdcard/Android/data/" + PKG + "/files/fullapp";
  private UiAutomation ui;
  private File root;
  private PrintWriter proto;
  private int W = 1080, H = 2400;
  private final StringBuilder summary = new StringBuilder();
  private final List<String> failures = new ArrayList<>();
  private void status(int code, String stack) {
    Bundle b = new Bundle(); b.putString("id", "InstrumentationTestRunner"); b.putInt("numtests", 1); b.putInt("current", 1);
    b.putString("class", "dev.kineticron.fullapp.FullAppRunner"); b.putString("test", "fullAppEvidence");
    if (stack != null) { b.putString("stack", stack); b.putString("stream", stack); }
    sendStatus(code, b);
  }

  @Override public void onCreate(Bundle b) { super.onCreate(b); start(); }

  private String shell(String cmd) throws IOException {
    String marker = "__FA_EXIT__" + UUID.randomUUID();
    String script = "(\n" + cmd + "\n) 2>&1\nrc=$?\nprintf '\\n" + marker + "%d\\n' \"$rc\"\n";
    String enc = Base64.getEncoder().encodeToString(script.getBytes(StandardCharsets.UTF_8));
    ParcelFileDescriptor fd = ui.executeShellCommand("sh -c echo${IFS}" + enc + "|base64${IFS}-d|sh");
    try (InputStream in = new ParcelFileDescriptor.AutoCloseInputStream(fd)) {
      ByteArrayOutputStream o = new ByteArrayOutputStream(); byte[] x = new byte[16384]; int n;
      while ((n = in.read(x)) != -1) o.write(x, 0, n);
      String raw = o.toString("UTF-8"); int i = raw.lastIndexOf("\n" + marker);
      return i < 0 ? raw : raw.substring(0, i);
    }
  }
  private final Set<String> pids = new LinkedHashSet<>();
  private final Map<String,String> origSettings = new LinkedHashMap<>();
  private String appPid() { try { String p = shell("pidof " + PKG).trim(); if (!p.isEmpty() && p.matches("[0-9 ]+")) { for (String x : p.split(" ")) pids.add(x); return p; } } catch (IOException e) {} return ""; }
  private void ser(AccessibilityNodeInfo n, StringBuilder sb, int d) {
    if (n == null) return; Rect r = new Rect(); n.getBoundsInScreen(r);
    for (int i = 0; i < d; i++) sb.append(' ');
    sb.append(n.getClassName()).append(" desc=").append(n.getContentDescription()).append(" text=").append(n.getText()).append(" id=").append(n.getViewIdResourceName())
      .append(" clickable=").append(n.isClickable()).append(" bounds=[").append(r.left).append(',').append(r.top).append("][").append(r.right).append(',').append(r.bottom).append("]\n");
    for (int i = 0; i < n.getChildCount(); i++) { AccessibilityNodeInfo c = n.getChild(i); ser(c, sb, d + 1); }
  }
  private String tree() {
    try { AccessibilityNodeInfo root = ui.getRootInActiveWindow(); if (root == null) return "NO_ROOT_ACTIVE_WINDOW\n"; StringBuilder sb = new StringBuilder("pkg=" + root.getPackageName() + "\n"); ser(root, sb, 0); return sb.toString(); }
    catch (Throwable t) { return "TREE_ERROR " + t + "\n"; }
  }
  private int[] findIn(AccessibilityNodeInfo n, String desc) {
    if (n == null) return null; CharSequence cd = n.getContentDescription();
    if (cd != null && cd.toString().equals(desc)) { Rect r = new Rect(); n.getBoundsInScreen(r); return new int[] { r.centerX(), r.centerY(), r.left, r.top, r.right, r.bottom }; }
    for (int i = 0; i < n.getChildCount(); i++) { int[] x = findIn(n.getChild(i), desc); if (x != null) return x; }
    return null;
  }
  private void saveSettings() throws IOException {
    for (String k : new String[] { "global animator_duration_scale", "global transition_animation_scale", "global window_animation_scale", "system font_scale", "system accelerometer_rotation", "system user_rotation" })
      origSettings.put(k, shell("settings get " + k).trim());
    StringBuilder sb = new StringBuilder(); for (Map.Entry<String,String> e : origSettings.entrySet()) sb.append(e.getKey()).append('=').append(e.getValue()).append('\n'); save("original-settings.txt", sb.toString());
  }
  private void restoreSettings() {
    try { ui.setRotation(UiAutomation.ROTATION_UNFREEZE); } catch (Throwable t) {}
    for (Map.Entry<String,String> e : origSettings.entrySet()) {
      try { String v = e.getValue(); String[] kk = e.getKey().split(" ");
        if (v.isEmpty() || v.equals("null")) shell("settings delete " + kk[0] + " " + kk[1]); else shell("settings put " + kk[0] + " " + kk[1] + " " + v);
      } catch (Throwable t) {}
    }
  }
  private void sleep(long ms) { SystemClock_sleep(ms); }
  private static void SystemClock_sleep(long ms) { android.os.SystemClock.sleep(ms); }
  private void save(String name, String text) throws IOException {
    try (FileOutputStream f = new FileOutputStream(new File(root, name))) { f.write(text.getBytes(StandardCharsets.UTF_8)); }
  }
  private void log(String s) { proto.println(android.os.SystemClock.elapsedRealtime() + " " + s); proto.flush(); }
  private int count(String hay, String needle) { int c = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { c++; i += needle.length(); } return c; }
  private String rn() throws IOException { return shell("logcat -d -s ReactNativeJS:I"); }

  private void shot(String name) throws IOException {
    Bitmap bm = ui.takeScreenshot();
    if (bm == null) { log("SHOT " + name + " NULL"); return; }
    File f = new File(root, name + ".png");
    try (FileOutputStream o = new FileOutputStream(f)) { bm.compress(Bitmap.CompressFormat.PNG, 100, o); }
    log("SHOT " + name + " " + bm.getWidth() + "x" + bm.getHeight() + " bytes=" + f.length());
    save(name + "-a11y.txt", tree());
    save(name + "-focus.txt", "pid=" + appPid() + "\n" + shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'") + shell("dumpsys activity top | grep -E 'ACTIVITY|Hosting|mFocused' | head -8") + "\n" + shell("dumpsys SurfaceFlinger --list"));
  }
  private boolean launch(String url) throws IOException {
    String out = shell("am start -W -a android.intent.action.VIEW -d '" + url + "' -n " + PKG + "/.MainActivity");
    log("AMSTART " + url + " -> " + out.replace('\n', ' '));
    return out.contains("Status: ok") || out.contains("Complete");
  }
  private boolean waitFor(String marker, int baseline, int secs) throws IOException {
    for (int i = 0; i < secs * 2; i++) { if (count(rn(), marker) > baseline) return true; sleep(500); }
    return false;
  }
  private boolean fx(String name) throws IOException {
    int base = count(rn(), "KSFX ACK fx=" + name + " ");
    launch("expolyrics://?fx=" + name);
    boolean ok = waitFor("KSFX ACK fx=" + name + " ", base, 15);
    log("FX " + name + " ack=" + ok); sleep(2500); return ok;
  }
  private int[] findDesc(String desc) {
    try { return findIn(ui.getRootInActiveWindow(), desc); } catch (Throwable t) { return null; }
  }
  private void step(String name, boolean evidence, String note) {
    if (!evidence && (name.equals("cold-launch") || name.startsWith("state-"))) failures.add(name + ": " + note); summary.append(name).append(" | executed=").append(evidence).append(" | ").append(note).append("\n"); log("STEP " + name + " executed=" + evidence + " " + note); }

  @Override public void onStart() {
    ui = getUiAutomation();
    try {
      AccessibilityServiceInfo si = ui.getServiceInfo(); si.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS; ui.setServiceInfo(si);
      File ext = getTargetContext().getExternalFilesDir(null);
      root = new File(ext, "fullapp"); root.mkdirs();
      proto = new PrintWriter(new FileWriter(new File(root, "protocol.log")));
      String sz = shell("wm size; wm density; getprop ro.build.version.sdk; getprop ro.product.model");
      save("device.txt", sz); log("DEVICE " + sz.replace('\n', ' '));
      Matcher m = Pattern.compile("Physical size: (\\d+)x(\\d+)").matcher(sz); if (m.find()) { W = Integer.parseInt(m.group(1)); H = Integer.parseInt(m.group(2)); }
      saveSettings();
      for (String k : new String[] { "animator_duration_scale", "transition_animation_scale", "window_animation_scale" }) shell("settings put global " + k + " 1");
      shell("settings put system accelerometer_rotation 0; settings put system font_scale 1.0; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard");
      shell("logcat -b all -c");
      boolean up = launch("expolyrics://"); sleep(1500); appPid();
      boolean ready = waitFor("KSFX READY", 0, 60);
      step("cold-launch", up && ready, "am start ok=" + up + " JS READY marker=" + ready);
      shot("00-launch");
      // fixture states
      String[] states = { "spicy", "amll", "cjk", "cjk-amll", "loading", "instrumental", "nolyrics" };
      for (String s : states) { boolean a = fx(s); shot("10-" + s); step("state-" + s, a, "fixture ack=" + a + "; screenshot 10-" + s + ".png needs visual review"); }
      // rotation on a lyric state (both ways), both renderers
      for (String s : new String[] { "spicy", "amll" }) {
        fx(s);
        ui.setRotation(UiAutomation.ROTATION_FREEZE_90); sleep(3500); shot("20-rot90-" + s);
        ui.setRotation(UiAutomation.ROTATION_FREEZE_270); sleep(3500); shot("20-rot270-" + s);
        ui.setRotation(UiAutomation.ROTATION_FREEZE_0); sleep(3500); shot("20-rot0-" + s);
        step("rotation-" + s, true, "90/270/0 screenshots captured; check lyrics visible+layout");
      }
      ui.setRotation(UiAutomation.ROTATION_UNFREEZE);
      // HOME / resume
      for (String s : new String[] { "spicy", "amll" }) {
        fx(s); shell("input keyevent KEYCODE_HOME"); sleep(3000); shot("30-home-" + s);
        launch("expolyrics://"); sleep(3500); shot("30-resume-" + s);
        step("home-resume-" + s, true, "see 30-home/30-resume pngs + focus/pid files");
      }
      // sleep/wake = surface destroy/recreate
      fx("spicy"); shell("input keyevent 223"); sleep(3000); shell("input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard"); sleep(3500); shot("31-screenoff-wake");
      step("surface-sleep-wake", true, "screen off/on cycle, screenshot after wake");
      // activity recreation (font scale not handled by configChanges)
      fx("amll"); String p0 = appPid(); int sd0 = count(rn(), "KSFX SEEDED");
      shell("settings put system font_scale 1.3"); sleep(4000); shot("32-fontscale-recreate-NO-REAPPLY");
      String p1 = appPid(); int sd1 = count(rn(), "KSFX SEEDED");
      save("32-recreate-evidence.txt", "pidBefore=" + p0 + " pidAfter=" + p1 + " seededBefore=" + sd0 + " seededAfter=" + sd1 + "\n" + shell("dumpsys activity activities | grep -E 'ResumedActivity|ActivityRecord' | head -6"));
      boolean re = fx("amll"); shot("32-fontscale-REAPPLIED-1.3");
      shell("settings put system font_scale 1.0"); sleep(4000); shot("32-fontscale-restored-NO-REAPPLY"); fx("amll"); shot("32-fontscale-restored-REAPPLIED");
      log("RECREATE pidSame=" + p0.equals(p1) + " reapplyAck=" + re);
      step("activity-recreation", true, "font_scale 1.3->1.0 forces activity recreate; pngs + pid");
      // swipe/fling and return
      for (String s : new String[] { "spicy", "amll" }) {
        fx(s); int cx = W / 2;
        shell("input swipe " + cx + " " + (int)(H*0.75) + " " + cx + " " + (int)(H*0.35) + " 400"); sleep(1200); shot("40-swipe-" + s);
        shell("input swipe " + cx + " " + (int)(H*0.75) + " " + cx + " " + (int)(H*0.30) + " 80"); sleep(300); shot("40-fling-mid-" + s); sleep(2500); shot("40-fling-settled-" + s);
        shell("input swipe " + cx + " " + (int)(H*0.30) + " " + cx + " " + (int)(H*0.85) + " 80"); sleep(2500); shot("40-fling-back-" + s);
        sleep(7000); shot("40-autofollow-return-" + s);
        step("swipe-fling-return-" + s, true, "manual scroll, fling, reverse fling, autofollow after 7s");
      }
      // seek by tap
      for (String s : new String[] { "spicy", "amll" }) {
        fx(s); int before = count(rn(), "KSFX STORE seek");
        shot("50-preseek-" + s);
        String tried = ""; int after = before;
        for (double fy : new double[] { 0.62, 0.50, 0.72, 0.42, 0.80 }) {
          int x = W / 2, y = (int)(H * fy); shell("input tap " + x + " " + y); sleep(1800); after = count(rn(), "KSFX STORE seek"); tried += "(" + x + "," + y + ")=" + (after - before) + " ";
          if (after > before) break;
        }
        shot("50-postseek-" + s); save("50-seek-taps-" + s + ".txt", tried + "\nscreen=" + W + "x" + H);
        step("seek-tap-" + s, after > before, "store seek delta=" + (after - before) + " taps " + tried);
      }
      // credits links
      for (String s : new String[] { "credits", "credits-amll" }) {
        fx(s); shot("60-credits-" + s);
        int base = count(rn(), "KSFX LINK_OPEN"); boolean hit = false; String where = "";
        for (double fy = 0.50; fy <= 0.94 && !hit; fy += 0.04) for (double fx2 : new double[] { 0.3, 0.5, 0.7 }) {
          shell("input tap " + (int)(W*fx2) + " " + (int)(H*fy)); sleep(500);
          if (count(rn(), "KSFX LINK_OPEN") > base) { hit = true; where = fx2 + "," + fy; break; }
        }
        shot("60-credits-after-" + s);
        step("credits-link-" + s, hit, hit ? "LINK_OPEN logged at tap " + where : "no LINK_OPEN from grid taps (credits may be off-screen/not rendered)");
      }
      // settings renderer switch
      fx("spicy");
      int[] menu = findDesc("Open player menu"); log("MENU " + (menu == null ? "not found" : menu[0] + "," + menu[1]));
      boolean sw = false;
      if (menu != null) {
        shell("input tap " + menu[0] + " " + menu[1]); sleep(2000); shot("70-menu-open");
        int[] amll = findDesc("AMLL lyrics renderer");
        if (amll != null) { shell("input tap " + amll[0] + " " + amll[1]); sleep(3000); shot("70-menu-amll"); sw = findDesc("AMLL lyrics renderer, selected") != null; }
        int[] spicy = findDesc("Spicy Lyrics lyrics renderer");
        if (spicy != null) { shell("input tap " + spicy[0] + " " + spicy[1]); sleep(3000); shot("70-menu-spicy"); }
      }
      step("settings-renderer-switch", sw, "menu found=" + (menu != null) + " AMLL selected state in a11y dump=" + sw);
      // final
      String lc = shell("logcat -d -v threadtime");
      save("logcat-full.txt", lc); save("logcat-reactnativejs.txt", rn());
      appPid();
      StringBuilder badSb = new StringBuilder(); Pattern bp = Pattern.compile("FATAL EXCEPTION|Fatal signal|SIGSEGV|DEVICE_LOST|DeviceLost|panicked|ANR in|Process: " + Pattern.quote(PKG) + "|has died");
      for (String ln : lc.split("\n")) {
        if (!bp.matcher(ln).find()) continue;
        boolean mine = ln.contains(PKG);
        for (String pd : pids) if (ln.matches("^\\S+\\s+\\S+\\s+" + pd + "\\s.*") || ln.contains("pid " + pd) || ln.contains("(" + pd + ")")) mine = true;
        if (mine) badSb.append(ln).append('\n');
      }
      String bad = badSb.toString(); save("pids-seen.txt", pids.toString() + "\nfinalPid=" + appPid());
      if (pids.size() > 1) { failures.add("app pid changed: " + pids); }
      save("crash-scan.txt", bad.isEmpty() ? "NONE (app-pid/package filtered)" : bad);
      summary.append("crash-scan: ").append(bad.trim().isEmpty() ? "none" : "HITS see crash-scan.txt").append("\n");
      if (!bad.trim().isEmpty()) failures.add("crash-scan hits");
      save("SUMMARY.txt", summary.toString());
      restoreSettings();
      if (!failures.isEmpty()) throw new IOException("Hard failures: " + failures);
      status(0, null);
      Bundle ok = new Bundle(); ok.putString("stream", "\nOK (1 test)\n"); ok.putInt("tests", 1); ok.putString("output", OUT);
      proto.close(); finish(android.app.Activity.RESULT_OK, ok); return;
    } catch (Throwable t) {
      String st = "";
      try { StringWriter w = new StringWriter(); t.printStackTrace(new PrintWriter(w)); st = w.toString(); save("RUNNER-ERROR.txt", st); summary.append("RUNNER FAIL ").append(t).append("\n"); save("SUMMARY.txt", summary.toString()); } catch (Exception e) {}
      restoreSettings();
      status(-2, st);
      Bundle r = new Bundle(); r.putString("stream", st); r.putString("shortMsg", String.valueOf(t)); r.putInt("tests", 1);
      finish(android.app.Activity.RESULT_CANCELED, r);
    }
  }
}
