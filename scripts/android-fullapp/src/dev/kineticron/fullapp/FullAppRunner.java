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
  private static final String DEV_MENU_INTRO =
    "This is the developer menu. It gives you access to useful tools in your development builds.";
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
    W = bm.getWidth(); H = bm.getHeight();
    File f = new File(root, name + ".png");
    try (FileOutputStream o = new FileOutputStream(f)) { bm.compress(Bitmap.CompressFormat.PNG, 100, o); }
    log("SHOT " + name + " " + bm.getWidth() + "x" + bm.getHeight() + " bytes=" + f.length());
    bm.recycle();
    save(name + "-a11y.txt", tree());
    save(name + "-focus.txt", "pid=" + appPid() + "\n" + shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'") + shell("dumpsys activity top | grep -E 'ACTIVITY|Hosting|mFocused' | head -8") + "\n" + shell("dumpsys SurfaceFlinger --list"));
  }
  private void refreshSize() throws IOException {
    Bitmap bitmap = ui.takeScreenshot();
    if (bitmap == null) throw new IOException("No screenshot for current display geometry");
    W = bitmap.getWidth(); H = bitmap.getHeight(); bitmap.recycle();
  }
  private boolean orient(int rotation) throws IOException {
    // Device rotation is a request, not proof that an app orientation lock yielded.
    boolean landscape = rotation == UiAutomation.ROTATION_FREEZE_90;
    if (!ui.setRotation(rotation)) {
      log("SETUP_ORIENTATION_REJECTED requested=" + (landscape ? "landscape" : "portrait"));
      return false;
    }
    for (int i = 0; i < 16; i++) {
      sleep(500); refreshSize();
      if (landscape ? W > H : H > W) {
        log("ORIENTATION requested=" + (landscape ? "landscape" : "portrait") + " actual=" + W + "x" + H);
        return true;
      }
    }
    log("SETUP_ORIENTATION_MISMATCH requested=" + (landscape ? "landscape" : "portrait") + " display=" + W + "x" + H);
    return false;
  }
  private boolean targetedTap(String kind, String fixture, boolean landscape) throws IOException {
    String request = kind + "-" + android.os.SystemClock.elapsedRealtime();
    String marker = "KSFX TARGET request=" + request + " ";
    String windowMarker = "KSFX WINDOW request=" + request + " ";
    if (!launch("expolyrics://?fx=probe-" + kind + "&request=" + request)) return false;
    if (!waitFor(windowMarker, 0, 20)) {
      log("SETUP_APP_WINDOW_MISSING fixture=" + fixture + " request=" + request);
      save("target-" + request + ".txt", "SETUP app window unverified\n" + rn());
      return false;
    }
    Matcher window = Pattern.compile(Pattern.quote(windowMarker)
      + "windowWidth=([0-9.]+) windowHeight=([0-9.]+) canvasWidth=([0-9.]+) canvasHeight=([0-9.]+)"
      + " style=(amll|spicy) track=([a-zA-Z0-9-]+)").matcher(rn());
    if (!window.find()) return false;
    String expectedStyle = fixture.endsWith("amll") ? "amll" : "spicy";
    String expectedTrack = "fx-track-" + (kind.equals("link") ? "credits" : fixture);
    if (!expectedStyle.equals(window.group(5)) || !expectedTrack.equals(window.group(6))) {
      save("target-" + request + ".txt", "Fixture mismatch: expected style=" + expectedStyle
        + " track=" + expectedTrack + "\n" + window.group() + "\n" + rn());
      return false;
    }
    double windowWidth = Double.parseDouble(window.group(1)), windowHeight = Double.parseDouble(window.group(2));
    double canvasWidth = Double.parseDouble(window.group(3)), canvasHeight = Double.parseDouble(window.group(4));
    // Sampled by the probe after this fixture, not inferred from display rotation.
    boolean appOrientationOk = Double.isFinite(windowWidth) && Double.isFinite(windowHeight)
      && windowWidth > 0 && windowHeight > 0
      && (landscape ? windowWidth > windowHeight : windowHeight > windowWidth)
      && Double.isFinite(canvasWidth) && Double.isFinite(canvasHeight) && canvasWidth > 0 && canvasHeight > 0;
    if (!appOrientationOk) {
      log("SETUP_APP_ORIENTATION_MISMATCH fixture=" + fixture + " requested=" + (landscape ? "landscape" : "portrait") + " window=" + window.group());
      save("target-" + request + ".txt", "SETUP failure, not renderer evidence\n" + window.group() + "\n" + rn());
      return false;
    }
    if (!waitFor(marker, 0, 20)) {
      save("target-" + request + ".txt", rn());
      return false;
    }
    String logs = rn();
    Matcher target = Pattern.compile(Pattern.quote(marker) + "x=(\\d+) y=(\\d+) expected=(-?\\d+) url=([^\\s]*)").matcher(logs);
    if (!target.find()) return false;
    int x = Integer.parseInt(target.group(1)), y = Integer.parseInt(target.group(2));
    int expected = Integer.parseInt(target.group(3));
    String url = target.group(4);
    refreshSize();
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    if (kind.equals("seek") && expected <= 0) return false;
    if (kind.equals("link") && (expected != -3 || !url.equals("https://example.com/maker"))) return false;
    String event = kind.equals("seek")
      ? "KSFX SEEK_OK request=" + request + " expected=" + expected + " actual=" + expected
      : "KSFX LINK_OK request=" + request + " url=https://example.com/maker";
    int baseline = count(logs, event);
    shell("input tap " + x + " " + y);
    boolean ok = waitFor(event, baseline, 8);
    save("target-" + request + ".txt", "fixture=" + fixture + " screen=" + W + "x" + H + "\n"
      + window.group() + "\n" + target.group() + "\nexpectedEvent=" + event + "\nobserved=" + ok + "\n" + rn());
    return ok;
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
    String request = "fixture-" + android.os.SystemClock.elapsedRealtime();
    boolean launched = launch("expolyrics://?fx=" + name + "&request=" + request);
    Pattern ack = Pattern.compile(Pattern.quote("KSFX ACK fx=" + name + " ")
      + "[^\\r\\n]* request=" + request + " source=(event|initial) ");
    boolean ok = false;
    for (int i = 0; launched && i < 30 && !ok; i++) {
      ok = ack.matcher(rn()).find();
      if (!ok) sleep(500);
    }
    log("FX " + name + " ack=" + ok + " request=" + request); sleep(2500); return ok;
  }
  private boolean initialSpicyFixture() throws IOException {
    String request = "startup-" + android.os.SystemClock.elapsedRealtime();
    log("INITIAL_FIXTURE_REQUEST fx=spicy request=" + request);
    if (!launch("expolyrics://?fx=spicy&request=" + request)) return false;
    if (!waitFor("request=" + request + " source=event ", 0, 15)) return false;
    Pattern expected = Pattern.compile("KSFX ACK fx=spicy style=spicy lines=[1-9][0-9]* playing=true pos=[0-9]+"
      + " request=" + request + " source=event track=fx-track-spicy title=\"Fixture spicy\""
      + " connection=connected mode=desktop appOnboardingVisible=false tourActive=false\\s*$", Pattern.MULTILINE);
    return expected.matcher(rn()).find();
  }
  private int[] findDesc(String desc) {
    try { return findIn(ui.getRootInActiveWindow(), desc); } catch (Throwable t) { return null; }
  }
  private int[] findVisibleLabel(AccessibilityNodeInfo n, String label, boolean description) {
    if (n == null) return null;
    CharSequence value = description ? n.getContentDescription() : n.getText();
    if (PKG.contentEquals(n.getPackageName() == null ? "" : n.getPackageName())
        && value != null && label.contentEquals(value) && n.isVisibleToUser()) {
      Rect r = new Rect(); n.getBoundsInScreen(r);
      if (r.width() > 0 && r.height() > 0) return new int[] {r.centerX(), r.centerY()};
    }
    for (int i = 0; i < n.getChildCount(); i++) {
      int[] p = findVisibleLabel(n.getChild(i), label, description); if (p != null) return p;
    }
    return null;
  }
  private boolean playerIdentity(AccessibilityNodeInfo window, String fixture) {
    String title = "Fixture " + fixture;
    return window != null && window.getPackageName() != null && PKG.contentEquals(window.getPackageName())
      && findVisibleLabel(window, "Open player menu", true) != null
      && (findVisibleLabel(window, title, false) != null
        || findVisibleLabel(window, title + ", KineSync Test. Show album artwork", true) != null)
      && findVisibleLabel(window, "Close", true) == null
      && findVisibleLabel(window, "Close player menu", true) == null;
  }
  private boolean dismissDevMenu() throws IOException {
    boolean continued = false, closed = false;
    int clearSamples = 0;
    for (int i = 0; i < 60; i++) {
      AccessibilityNodeInfo window = ui.getRootInActiveWindow();
      int[] next = findVisibleLabel(window, "Continue", false);
      int[] close = findVisibleLabel(window, "Close", true);
      boolean onboarding = findVisibleLabel(window, DEV_MENU_INTRO, false) != null;
      boolean regularMenu = findVisibleLabel(window, "Reload", false) != null;
      if (onboarding && next != null && !continued) {
        log("DEV_MENU_CONTINUE_TAP x=" + next[0] + " y=" + next[1]);
        shell("input tap " + next[0] + " " + next[1]);
        continued = true;
      } else if (!onboarding && next == null && regularMenu && close != null && !closed) {
        log("DEV_MENU_CLOSE_TAP x=" + close[0] + " y=" + close[1]);
        shell("input tap " + close[0] + " " + close[1]);
        closed = true;
      }
      boolean appVisible = findVisibleLabel(window, "Desktop Bridge is not connected", false) != null;
      boolean clear = appVisible && !onboarding && next == null && !regularMenu && close == null
        && (!continued || closed);
      clearSamples = clear ? clearSamples + 1 : 0;
      if (clearSamples >= 3) {
        log("DEV_MENU_RESULT " + (closed ? "closed continued=" + continued : "already clear"));
        return true;
      }
      sleep(500);
    }
    log("DEV_MENU_RESULT timeout continued=" + continued + " closed=" + closed);
    return false;
  }
  private boolean bootstrapEmbeddedBundle() throws IOException {
    // Instrumentation lives in target process, so never force-stop that package here.
    String out = shell("am start -W -a android.intent.action.MAIN -n " + PKG + "/.MainActivity");
    log("EMBEDDED_BOOTSTRAP_LAUNCH " + out.replace('\n', ' '));
    boolean started = out.contains("Status: ok");
    log("ANDROID_LAUNCH_SUCCESS=" + started);
    int[] button = null;
    for (int i = 0; started && i < 60 && button == null; i++) {
      button = findVisibleLabel(ui.getRootInActiveWindow(), "Load embedded bundle", false);
      if (button == null) sleep(500);
    }
    shot("00-embedded-launcher");
    boolean ready = false, setup = false, dismissed = false, seedReady = false, player = false;
    if (button != null) {
      log("EMBEDDED_BOOTSTRAP_TAP x=" + button[0] + " y=" + button[1]);
      shell("input tap " + button[0] + " " + button[1]);
      ready = waitFor("KSFX READY bundle=embedded", 0, 60);
    }
    log("EMBEDDED_ASSET_READY=" + ready);
    if (ready) {
      shot("00-devmenu-before");
      setup = waitFor("KSFX APP_SETUP_READY ", 0, 30);
      log("APP_SETUP_READY=" + setup);
      if (setup) dismissed = dismissDevMenu();
      shot("00-devmenu-after");
    }
    log("EXPO_ONBOARDING_DISMISSED=" + dismissed);
    if (dismissed) seedReady = initialSpicyFixture();
    log("INITIAL_SEED_READY=" + seedReady);
    for (int i = 0; seedReady && i < 30 && !player; i++) {
      player = playerIdentity(ui.getRootInActiveWindow(), "spicy");
      if (!player) sleep(500);
    }
    log("PLAYER_IDENTITY=" + player);
    save("00-embedded-bootstrap.txt", "started=" + started + " embeddedButton=" + (button != null)
      + " ready=" + ready + " appSetupReady=" + setup + " expoOnboardingDismissed=" + dismissed
      + " seedReady=" + seedReady + " playerIdentity=" + player + "\n" + tree() + "\n" + rn());
    return player;
  }
  private void settingsRouteEvidence() throws IOException {
    boolean portrait = orient(UiAutomation.ROTATION_FREEZE_0);
    for (String style : new String[] { "spicy", "amll" }) {
      String prefix = "69-settings-" + style;
      boolean seeded = fx(style);
      boolean beforePlayer = seeded && playerIdentity(ui.getRootInActiveWindow(), style);
      boolean nativeTarget = portrait && beforePlayer && targetedTap("seek", style, false);
      shot(prefix + "-BEFORE");
      boolean opened = launch("expolyrics://explore");
      boolean settingsIdentity = false;
      for (int i = 0; opened && i < 20 && !settingsIdentity; i++) {
        AccessibilityNodeInfo window = ui.getRootInActiveWindow();
        settingsIdentity = findVisibleLabel(window, "Settings", false) != null
          && (findVisibleLabel(window, "PLAYBACK SOURCE", false) != null
            || findVisibleLabel(window, "Playback source", true) != null);
        if (!settingsIdentity) sleep(500);
      }
      sleep(2000);
      shot(prefix + "-DURING");
      if (settingsIdentity) {
        shell("input keyevent KEYCODE_BACK");
        sleep(3000);
      }
      shot(prefix + "-AFTER-RETURN-RAW");
      String returnTree = tree();
      boolean returned = settingsIdentity && playerIdentity(ui.getRootInActiveWindow(), style)
        && !returnTree.contains("text=Settings");
      boolean rawReturnTarget = returned && targetedTap("seek", style, false);
      save(prefix + "-raw-return-native.txt",
        "positivePlayerIdentity=" + returned + " nativeWindowTargetTapBeforeReseed=" + rawReturnTarget
        + "\n" + returnTree + "\n" + rn());
      boolean afterAck = rawReturnTarget && fx(style);
      boolean afterTarget = afterAck && targetedTap("seek", style, false);
      shot(prefix + "-AFTER-RESEEDED");
      boolean setup = nativeTarget && settingsIdentity && returned && rawReturnTarget && afterTarget;
      save(prefix + "-evidence.txt",
        "displayPortrait=" + portrait + " seeded=" + seeded + " beforePlayerIdentity=" + beforePlayer
        + " nativeTargetBefore=" + nativeTarget + " opened=" + opened
        + " settingsIdentity=" + settingsIdentity + " returned=" + returned
        + " rawReturnNativeTargetBeforeReseed=" + rawReturnTarget + " afterAck=" + afterAck
        + " nativeTargetAfterReseed=" + afterTarget
        + "\nReview the screenshots for visible lyrics BEFORE and AFTER-RETURN-RAW and absence of lyric bleed DURING.\n" + rn());
      step("settings-route-" + style, setup,
        "native interaction and route identity setup=" + setup + "; visual review of BEFORE/DURING/AFTER-RETURN-RAW required");
      if (!setup) failures.add("settings-route-" + style + ": evidence setup incomplete");
    }
  }
  private void closePlayerMenu() throws IOException {
    int[] close = findVisibleLabel(ui.getRootInActiveWindow(), "Close player menu", true);
    if (close != null) {
      shell("input tap " + close[0] + " " + close[1]);
      sleep(1000);
    }
  }
  private void footerStyleSwitchEvidence(boolean portrait) throws IOException {
    closePlayerMenu();
    boolean seeded = fx("credits");
    shot("71-footer-spicy-BEFORE");
    boolean initialLink = portrait && seeded && playerIdentity(ui.getRootInActiveWindow(), "credits")
      && targetedTap("link", "credits", false);
    boolean sequenceComplete = initialLink;
    for (String style : new String[] { "amll", "spicy" }) {
      String label = (style.equals("amll") ? "AMLL" : "Spicy Lyrics") + " lyrics renderer";
      int[] menu = findVisibleLabel(ui.getRootInActiveWindow(), "Open player menu", true);
      int[] option = null;
      if (menu != null) {
        shell("input tap " + menu[0] + " " + menu[1]);
        sleep(1500);
        option = findVisibleLabel(ui.getRootInActiveWindow(), label, true);
      }
      boolean selected = false;
      if (option != null) {
        shell("input tap " + option[0] + " " + option[1]);
        sleep(2500);
        selected = findVisibleLabel(ui.getRootInActiveWindow(), label + ", selected", true) != null;
      }
      shot("71-footer-menu-" + style);
      closePlayerMenu();
      shot("71-footer-" + style + "-AFTER-SWITCH");
      boolean link = portrait && seeded && selected && playerIdentity(ui.getRootInActiveWindow(), "credits")
        && targetedTap("link", style.equals("amll") ? "credits-amll" : "credits", false);
      sequenceComplete = sequenceComplete && link;
      step("credits-link-style-switch-" + style, sequenceComplete,
        "initial footer tap=" + initialLink + " selected=" + selected + " same-track footer tap=" + link
        + "; visual review of 71-footer PNGs required");
    }
  }
  private void step(String name, boolean evidence, String note) {
    if (!evidence && (name.equals("cold-launch") || name.startsWith("state-") || name.startsWith("seek-tap-") || name.startsWith("credits-link-") || name.equals("orientation-portrait"))) failures.add(name + ": " + note); summary.append(name).append(" | executed=").append(evidence).append(" | ").append(note).append("\n"); log("STEP " + name + " executed=" + evidence + " " + note); }

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
      boolean up = bootstrapEmbeddedBundle(); sleep(1500); appPid();
      step("cold-launch", up, "See 00-embedded-bootstrap.txt for launch, readiness, and player evidence");
      shot("00-launch");
      if (!up) throw new IOException("Embedded fixture bootstrap failed; no UI scenarios executed");
      settingsRouteEvidence();
      // Seek and footer links in portrait and landscape. Targets come from the
      // real native hit-test within the measured canvas, never a tap grid.
      for (int rotation : new int[] { UiAutomation.ROTATION_FREEZE_0, UiAutomation.ROTATION_FREEZE_90 }) {
        boolean orientationOk = orient(rotation);
        String orientation = rotation == UiAutomation.ROTATION_FREEZE_90 ? "landscape" : "portrait";
        for (String s : new String[] { "spicy", "amll" }) {
          boolean ack = fx(s) && fx("pause");
          shot("50-preseek-" + orientation + "-" + s);
          boolean ok = orientationOk && ack && targetedTap("seek", s, rotation == UiAutomation.ROTATION_FREEZE_90);
          shot("50-postseek-" + orientation + "-" + s);
          step("seek-tap-" + orientation + "-" + s, ok, "accepted rotation + post-fixture app window + native target + exact seek/store anchor required, displaySetupOk=" + orientationOk + ", setup mismatches are not renderer failures");
        }
        for (String s : new String[] { "credits", "credits-amll" }) {
          // A footer tap keeps manual follow ownership on the shared credits track.
          // Stage AMLL on a different fixture track so its credits get fresh follow.
          boolean ack = (!s.equals("credits-amll") || fx("amll")) && fx(s);
          shot("60-credits-" + orientation + "-" + s);
          boolean ok = orientationOk && ack && targetedTap("link", s, rotation == UiAutomation.ROTATION_FREEZE_90);
          shot("60-credits-after-" + orientation + "-" + s);
          step("credits-link-" + orientation + "-" + s, ok, "accepted rotation + post-fixture app window + native maker target + exact fixture LINK_OPEN required, displaySetupOk=" + orientationOk + ", setup mismatches are not renderer failures");
        }
      }
      // Return to portrait before capturing the broad fixture states.
      orient(UiAutomation.ROTATION_FREEZE_0);
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
      boolean portraitOk = orient(UiAutomation.ROTATION_FREEZE_0);
      step("orientation-portrait", portraitOk, "SETUP display-only portrait request, measured=" + W + "x" + H + ", app window checked separately at each tap probe");
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
        fx(s); refreshSize(); int cx = W > H ? W * 3 / 4 : W / 2;
        shell("input swipe " + cx + " " + (int)(H*0.75) + " " + cx + " " + (int)(H*0.35) + " 400"); sleep(1200); shot("40-swipe-" + s);
        shell("input swipe " + cx + " " + (int)(H*0.75) + " " + cx + " " + (int)(H*0.30) + " 80"); sleep(300); shot("40-fling-mid-" + s); sleep(2500); shot("40-fling-settled-" + s);
        shell("input swipe " + cx + " " + (int)(H*0.30) + " " + cx + " " + (int)(H*0.85) + " 80"); sleep(2500); shot("40-fling-back-" + s);
        sleep(7000); shot("40-autofollow-return-" + s);
        step("swipe-fling-return-" + s, true, "manual scroll, fling, reverse fling, autofollow after 7s");
      }
      ui.setRotation(UiAutomation.ROTATION_UNFREEZE);
      boolean settingsDisplayPortrait = orient(UiAutomation.ROTATION_FREEZE_0);
      log("SETUP settings portrait displayOnly=" + settingsDisplayPortrait + ", app window unverified, settings steps remain evidence-only");
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
      footerStyleSwitchEvidence(settingsDisplayPortrait);
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
