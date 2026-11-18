package dev.kineticron.fullapp;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.*;

/** Full-app UI runner. Drives the REAL KineSync app (test build) via deep-link fixture states.
 *  Evidence only: every step records files; nothing is marked pass from command success alone. */
public final class FullAppRunner extends Instrumentation {
  static final String PKG = "dev.kineticron.KineSync";
  private static final String EXPORT_ROOT = "/sdcard/Download/kinesync-fullapp-nov18";
  private static final String MAKER_URL = "https://example.com/maker";
  private static final String DEV_MENU_INTRO =
    "This is the developer menu. It gives you access to useful tools in your development builds.";
  private UiAutomation ui;
  private File root;
  private PrintWriter proto;
  private boolean remainingGates;
  private long scenarioDeadline = Long.MAX_VALUE;
  private int requestNumber;
  private int W = 1080, H = 2400;
  private final StringBuilder summary = new StringBuilder();
  private final List<String> failures = new ArrayList<>();
  private void status(int code, String stack) {
    Bundle b = new Bundle(); b.putString("id", "InstrumentationTestRunner"); b.putInt("numtests", 1); b.putInt("current", 1);
    b.putString("class", "dev.kineticron.fullapp.FullAppRunner"); b.putString("test", "fullAppEvidence");
    if (stack != null) { b.putString("stack", stack); b.putString("stream", stack); }
    sendStatus(code, b);
  }

  @Override public void onCreate(Bundle b) {
    super.onCreate(b);
    remainingGates = b != null && Boolean.parseBoolean(b.getString("remainingGates"));
    start();
  }

  private String shell(String cmd) throws IOException {
    return shell(cmd, false);
  }

  private String shellChecked(String cmd) throws IOException {
    return shell(cmd, true);
  }

  private String shell(String cmd, boolean checked) throws IOException {
    if (SystemClock.elapsedRealtime() >= scenarioDeadline) throw new IOException("Remaining gates time budget exceeded");
    String marker = "__FA_EXIT__" + UUID.randomUUID();
    String script = "(\n" + cmd + "\n) 2>&1\nrc=$?\nprintf '\\n" + marker + "%d\\n' \"$rc\"\n";
    String enc = Base64.getEncoder().encodeToString(script.getBytes(StandardCharsets.UTF_8));
    ParcelFileDescriptor fd = ui.executeShellCommand("sh -c echo${IFS}" + enc + "|base64${IFS}-d|sh");
    try (InputStream in = new ParcelFileDescriptor.AutoCloseInputStream(fd)) {
      ByteArrayOutputStream o = new ByteArrayOutputStream(); byte[] x = new byte[16384]; int n;
      while ((n = in.read(x)) != -1) o.write(x, 0, n);
      String raw = o.toString("UTF-8"); int i = raw.lastIndexOf("\n" + marker);
      if (checked && (i < 0 || !raw.substring(i + marker.length() + 1).trim().equals("0"))) {
        throw new IOException("Shell command failed: " + cmd + "\n" + raw);
      }
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
  private File[] evidenceFiles() throws IOException {
    File[] files = root.listFiles(new FileFilter() {
      @Override public boolean accept(File file) { return file.isFile(); }
    });
    if (files == null) throw new IOException("Cannot list evidence in " + root);
    Arrays.sort(files, new Comparator<File>() {
      @Override public int compare(File a, File b) { return a.getName().compareTo(b.getName()); }
    });
    return files;
  }

  private void mirrorFile(File file, String destination) throws IOException {
    String partial = destination + ".partial";
    if (Build.VERSION.SDK_INT >= 31) {
      // Stream bytes to the shell. It never has to read Android/data directly.
      ParcelFileDescriptor[] pipes = ui.executeShellCommandRw("sh -c cat>" + partial + "&&echo${IFS}COPY_OK");
      try (BufferedReader result = new BufferedReader(new InputStreamReader(
          new ParcelFileDescriptor.AutoCloseInputStream(pipes[0]), StandardCharsets.UTF_8))) {
        try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipes[1]);
             InputStream in = new FileInputStream(file)) {
          byte[] bytes = new byte[32768];
          for (int n; (n = in.read(bytes)) != -1; ) out.write(bytes, 0, n);
        }
        if (!"COPY_OK".equals(result.readLine())) throw new IOException("Shell copy failed for " + file.getName());
      }
    } else {
      shellChecked(": > " + partial);
      try (InputStream in = new FileInputStream(file)) {
        byte[] bytes = new byte[6000];
        for (int n; (n = in.read(bytes)) != -1; ) {
          String chunk = Base64.getEncoder().encodeToString(Arrays.copyOf(bytes, n));
          shellChecked("printf %s " + chunk + " | base64 -d >> " + partial);
        }
      }
    }
    shellChecked("test \"$(wc -c < " + partial + ")\" -eq " + file.length() + " && mv " + partial + " " + destination
      + " && test \"$(wc -c < " + destination + ")\" -eq " + file.length());
  }

  private void exportEvidence(String path) throws IOException {
    shellChecked("mkdir -p " + path);
    File[] files = evidenceFiles();
    if (files.length == 0) throw new IOException("No evidence to export");
    IOException failure = null;
    StringBuilder lengths = new StringBuilder();
    for (File file : files) {
      try {
        if (!file.getName().matches("[a-zA-Z0-9_.-]+")) throw new IOException("Unexpected evidence filename " + file.getName());
        mirrorFile(file, path + "/" + file.getName());
        lengths.append(file.getName()).append(' ').append(file.length()).append('\n');
      } catch (IOException | RuntimeException e) {
        if (failure == null) failure = new IOException("Evidence export incomplete at " + path);
        failure.addSuppressed(e);
      }
    }
    String listing;
    try {
      listing = shellChecked("ls -l " + path);
    } catch (IOException e) {
      if (failure == null) throw e;
      failure.addSuppressed(e);
      throw failure;
    }
    Log.i("KineSyncFullApp", "Evidence at " + path + "\n" + listing);
    if (failure != null) throw failure;
    save("export-verification.txt", "Verified shell byte lengths\n" + lengths + "\n" + listing);
    mirrorFile(new File(root, "export-verification.txt"), path + "/export-verification.txt");
  }
  private void log(String s) { proto.println(android.os.SystemClock.elapsedRealtime() + " " + s); proto.flush(); }
  private int count(String hay, String needle) { int c = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { c++; i += needle.length(); } return c; }
  private String rn() throws IOException { return shell("logcat -d -s ReactNativeJS:I"); }

  private void shot(String name) throws IOException {
    Bitmap bm = ui.takeScreenshot();
    File f = new File(root, name + ".png");
    if (bm == null) {
      failures.add("Screenshot unavailable: " + name);
      log("SHOT " + name + " NULL");
    } else {
      try (FileOutputStream o = new FileOutputStream(f)) {
        W = bm.getWidth(); H = bm.getHeight();
        if (!bm.compress(Bitmap.CompressFormat.PNG, 100, o)) {
          failures.add("PNG encoding failed: " + name);
          log("SHOT " + name + " ENCODE_FAILED");
        }
      } finally {
        bm.recycle();
      }
      log("SHOT " + name + " " + W + "x" + H + " bytes=" + f.length());
    }
    save(name + "-a11y.txt", tree());
    save(name + "-focus.txt", "pid=" + appPid() + "\n" + shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'") + shell("dumpsys activity top | grep -E 'ACTIVITY|Hosting|mFocused' | head -8") + "\n" + shell("dumpsys SurfaceFlinger --list"));
  }
  private void refreshSize() throws IOException {
    Bitmap bitmap = ui.takeScreenshot();
    if (bitmap == null) throw new IOException("No screenshot for current display geometry");
    W = bitmap.getWidth(); H = bitmap.getHeight(); bitmap.recycle();
  }
  private boolean orient(int rotation) throws IOException {
    boolean landscape = rotation == UiAutomation.ROTATION_FREEZE_90 || rotation == UiAutomation.ROTATION_FREEZE_270;
    if (!ui.setRotation(rotation)) {
      log("SETUP_ORIENTATION_REJECTED requested=" + rotation);
      return false;
    }
    WindowManager windows = (WindowManager) getTargetContext().getSystemService(Context.WINDOW_SERVICE);
    for (int i = 0; i < 16; i++) {
      sleep(500);
      if (windows.getDefaultDisplay().getRotation() != rotation) continue;
      refreshSize();
      if (landscape ? W > H : H > W) {
        log("ORIENTATION requested=" + rotation + " actual=" + W + "x" + H);
        return true;
      }
    }
    log("SETUP_ORIENTATION_MISMATCH requested=" + rotation + " actual=" + windows.getDefaultDisplay().getRotation()
      + " display=" + W + "x" + H);
    return false;
  }

  private boolean tap(int x, int y) {
    long down = SystemClock.uptimeMillis();
    return touch(down, MotionEvent.ACTION_DOWN, x, y) && touch(down, MotionEvent.ACTION_UP, x, y);
  }

  private boolean touch(long down, int action, int x, int y) {
    MotionEvent press = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0);
    try {
      press.setSource(InputDevice.SOURCE_TOUCHSCREEN);
      return ui.injectInputEvent(press, true);
    } finally {
      press.recycle();
    }
  }

  private String awaitLog(Pattern pattern, int seconds) throws IOException {
    long until = SystemClock.elapsedRealtime() + seconds * 1000L;
    String logs;
    do {
      logs = rn();
      if (pattern.matcher(logs).find()) break;
      sleep(250);
    } while (SystemClock.elapsedRealtime() < until);
    return logs;
  }

  private boolean targetedTap(String kind, String fixture, boolean landscape, String stage) throws IOException {
    return nativeEvidence(kind, fixture, landscape, stage, true);
  }

  private boolean nativeEvidence(String kind, String fixture, boolean landscape, String stage, boolean tapTarget) throws IOException {
    boolean link = kind.equals("link");
    int attempts = link ? 4 : 3;
    String style = fixture.endsWith("amll") ? "amll" : "spicy";
    String track = "fx-track-" + (link ? "credits" : fixture);
    refreshSize();
    for (int attempt = 0; attempt < attempts; attempt++) {
      String request = kind + "-" + SystemClock.elapsedRealtime() + "-" + (++requestNumber);
      String file = "target-" + request + ".txt";
      String windowMarker = "KSFX WINDOW request=" + request + " ";
      String marker = "KSFX TARGET request=" + request + " ";
      String missing = "KSFX TARGET_MISSING request=" + request;
      String stale = "KSFX TARGET_STALE request=" + request;
      boolean launched = launch("expolyrics://?fx=probe-" + kind + "&request=" + request, false);
      String tokenEnd = "(?=[\\s'\",]|$)";
      Pattern probeResult = Pattern.compile(Pattern.quote(marker) + "|(?:"
        + Pattern.quote(missing) + "|" + Pattern.quote(stale) + ")" + tokenEnd, Pattern.MULTILINE);
      String logs = launched ? awaitLog(probeResult, 5) : rn();
      Matcher window = Pattern.compile(Pattern.quote(windowMarker)
        + "windowWidth=([0-9.]+) windowHeight=([0-9.]+) canvasWidth=([0-9.]+) canvasHeight=([0-9.]+)"
        + " style=(amll|spicy) track=([a-zA-Z0-9-]+)").matcher(logs);
      boolean hasWindow = window.find();
      boolean windowOk = false;
      double canvasHeight = 0;
      if (hasWindow) {
        double ww = Double.parseDouble(window.group(1)), wh = Double.parseDouble(window.group(2));
        double cw = Double.parseDouble(window.group(3));
        canvasHeight = Double.parseDouble(window.group(4));
        windowOk = style.equals(window.group(5)) && track.equals(window.group(6))
          && ww > 0 && wh > 0 && (landscape ? ww > wh : wh > ww)
          && cw > 0 && canvasHeight > 0 && Double.isFinite(cw) && Double.isFinite(canvasHeight);
      }

      Matcher target = Pattern.compile(Pattern.quote(marker) + "x=(\\d+) y=(\\d+) expected=(-?\\d+) url=([^\\s'\"]*)(?=[\\s'\"]|$)",
        Pattern.MULTILINE).matcher(logs);
      boolean hasTarget = target.find();
      int x = hasTarget ? Integer.parseInt(target.group(1)) : -1;
      int y = hasTarget ? Integer.parseInt(target.group(2)) : -1;
      int expected = hasTarget ? Integer.parseInt(target.group(3)) : 0;
      boolean validTarget = launched && windowOk && hasTarget && x < W && y < H
        && (link ? expected == -3 && MAKER_URL.equals(target.group(4)) : expected > 0);
      String event = link ? "KSFX LINK_OK request=" + request + " url=" + MAKER_URL
        : "KSFX SEEK_OK request=" + request + " expected=" + expected + " actual=" + expected;
      Pattern callback = Pattern.compile(Pattern.quote(event) + tokenEnd, Pattern.MULTILINE);
      String linkOpen = "KSFX LINK_OPEN " + MAKER_URL;
      Pattern exactLinkOpen = Pattern.compile(Pattern.quote(linkOpen) + tokenEnd, Pattern.MULTILINE);
      boolean injected = false, callbackOk = false;
      if (tapTarget && validTarget && !callback.matcher(logs).find()) {
        injected = tap(x, y);
        if (injected) {
          // A first portrait tap can reveal hidden controls. Re-probe promptly
          // while those controls are still visible, with a new request ID.
          logs = awaitLog(callback, link && !landscape && attempt == 0 ? 1 : 3);
          Matcher observed = callback.matcher(logs);
          int reportedTarget = logs.lastIndexOf(marker);
          callbackOk = observed.find() && (!link || (reportedTarget >= 0 && reportedTarget < observed.start()
            && exactLinkOpen.matcher(logs).region(reportedTarget, observed.start()).find()));
        }
      }
      String result = "windowOk=" + windowOk + " validTarget=" + validTarget + " inputTap=" + injected + " callback=" + callbackOk;
      save(file, "stage=" + stage + " fixture=" + fixture + " expectedStyle=" + style + " expectedTrack=" + track
        + " screen=" + W + "x" + H + " launched=" + launched + "\n"
        + (hasWindow ? window.group() + "\n" : "") + (hasTarget ? target.group() + "\n" : "")
        + result + "\nexpectedEvent=" + event + "\n" + logs);
      summary.append(stage).append(" | ").append(result).append(" | ").append(file).append('\n');
      if (tapTarget ? callbackOk : validTarget) return true;
      if (link && windowOk && attempt + 1 < attempts && (!hasTarget || attempt > 0)) {
        swipeForMaker(logs, missing, x, y, canvasHeight);
      }
      sleep(link && validTarget && attempt == 0 ? 100 : 500);
    }
    return false;
  }

  private void swipeForMaker(String logs, String missing, int targetX, int targetY, double canvasHeight) throws IOException {
    float density = getTargetContext().getResources().getDisplayMetrics().density;
    int height = (int) (canvasHeight * density);
    int x = targetX, from = Math.min(H - 1, targetY + height / 8), to = Math.max(height / 5, from - height / 2);
    // A miss reports the measured canvas origin as well as its logical size.
    Matcher box = Pattern.compile(Pattern.quote(missing) + " bounds=[{]\"x\":(-?[0-9.]+),\"y\":(-?[0-9.]+),"
      + "\"width\":([0-9.]+),\"height\":([0-9.]+)[}]").matcher(logs);
    if (box.find()) {
      x = (int) ((Double.parseDouble(box.group(1)) + Double.parseDouble(box.group(3)) / 2) * density);
      int top = (int) (Double.parseDouble(box.group(2)) * density);
      from = Math.min(H - 1, top + height * 2 / 3);
      to = Math.max(0, top + height / 4);
    }
    if (x < 0 || x >= W || to < 0 || from <= to) return;
    log("MAKER_SCROLL x=" + x + " from=" + from + " to=" + to);
    shellChecked("input swipe " + x + " " + from + " " + x + " " + to + " 400");
    sleep(1000);
  }

  private boolean launch(String url) throws IOException {
    return launch(url, true);
  }

  private boolean launch(String url, boolean wait) throws IOException {
    String command = (remainingGates ? "timeout 15 " : "") + "am start" + (wait ? " -W" : "");
    String out = shell(command + " -a android.intent.action.VIEW -d '" + url + "' -n " + PKG + "/.MainActivity");
    log("AMSTART " + url + " -> " + out.replace('\n', ' '));
    return wait ? out.contains("Status: ok") || out.contains("Complete")
      : out.contains("Starting: Intent") && !out.contains("Error");
  }
  private boolean waitFor(String marker, int baseline, int secs) throws IOException {
    for (int i = 0; i < secs * 2; i++) { if (count(rn(), marker) > baseline) return true; sleep(500); }
    return false;
  }
  private boolean fx(String name) throws IOException {
    String request = "fixture-" + android.os.SystemClock.elapsedRealtime();
    boolean launched = launch("expolyrics://?fx=" + name + "&request=" + request);
    Pattern ack = Pattern.compile(Pattern.quote("KSFX ACK fx=" + name + " ")
      + (name.equals("pause") ? "[^\\r\\n]* playing=false pos=[0-9]+" : "[^\\r\\n]*")
      + " request=" + request + " source=(event|initial) ");
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
    String out = shell((remainingGates ? "timeout 15 " : "")
      + "am start -W -a android.intent.action.MAIN -n " + PKG + "/.MainActivity");
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
  private interface Condition {
    boolean matches();
  }

  private boolean waitForUi(Condition condition) {
    for (int i = 0; i < 20; i++) {
      if (condition.matches()) return true;
      sleep(500);
    }
    return false;
  }

  private boolean waitForPlayer(String style, boolean afterSettings) {
    return waitForUi(new Condition() {
      @Override public boolean matches() {
        AccessibilityNodeInfo window = ui.getRootInActiveWindow();
        return playerIdentity(window, style) && (!afterSettings || !settingsIdentity(window));
      }
    });
  }

  private boolean waitForPower(PowerManager power, boolean interactive) {
    return waitForUi(new Condition() {
      @Override public boolean matches() { return power.isInteractive() == interactive; }
    });
  }

  private boolean settingsIdentity(AccessibilityNodeInfo window) {
    return findVisibleLabel(window, "Settings", false) != null
      && (findVisibleLabel(window, "PLAYBACK SOURCE", false) != null
        || findVisibleLabel(window, "Playback source", false) != null
        || findVisibleLabel(window, "Playback source", true) != null);
  }

  private void settingsRouteEvidence() throws IOException {
    boolean portrait = orient(UiAutomation.ROTATION_FREEZE_0);
    for (String style : new String[] { "spicy", "amll" }) {
      String prefix = "69-settings-" + style;
      // Keep rows stationary through Settings and the raw return. The pause is
      // acknowledged before opening Settings, with no fixture on the way back.
      boolean seeded = fx(style) && fx("pause");
      boolean beforePlayer = seeded && waitForPlayer(style, false);
      boolean nativeTarget = portrait && beforePlayer && targetedTap("seek", style, false, prefix + "-before");
      shot(prefix + "-BEFORE");
      boolean opened = launch("expolyrics://explore");
      boolean settings = opened && waitForUi(new Condition() {
        @Override public boolean matches() { return settingsIdentity(ui.getRootInActiveWindow()); }
      });
      if (settings) sleep(800);
      shot(prefix + "-DURING");
      if (settings) shellChecked("input keyevent KEYCODE_BACK");
      boolean returned = settings && waitForPlayer(style, true);
      shot(prefix + "-RETURN-FIRST-PLAYER");
      String returnTree = tree();
      boolean rawReturnTarget = portrait && returned && targetedTap("seek", style, false, prefix + "-raw-return");
      shot(prefix + "-AFTER-RETURN-RAW");
      save(prefix + "-raw-return-native.txt",
        "positivePlayerIdentity=" + returned + " nativeWindowTargetTapBeforeReseed=" + rawReturnTarget
        + "\n" + returnTree + "\n" + rn());
      boolean afterAck = rawReturnTarget && fx(style) && fx("pause");
      boolean afterTarget = afterAck && targetedTap("seek", style, false, prefix + "-after-reseed");
      shot(prefix + "-AFTER-RESEEDED");
      boolean setup = nativeTarget && settings && returned && rawReturnTarget && afterTarget;
      save(prefix + "-evidence.txt",
        "displayPortrait=" + portrait + " seededAndPaused=" + seeded + " beforePlayerIdentity=" + beforePlayer
        + " seekCallbackBefore=" + nativeTarget + " opened=" + opened
        + " settingsIdentity=" + settings + " returned=" + returned
        + " rawReturnSeekCallbackBeforeReseed=" + rawReturnTarget + " afterAck=" + afterAck
        + " seekCallbackAfterReseed=" + afterTarget + "\n" + rn());
      step("settings-route-" + style, setup,
        "See " + prefix + "-evidence.txt and BEFORE/DURING/AFTER-RETURN-RAW PNGs for visual review");
      if (!setup && !remainingGates) failures.add("settings-route-" + style + ": evidence setup incomplete");
    }
  }

  private boolean closePlayerMenu() {
    int[] close = findVisibleLabel(ui.getRootInActiveWindow(), "Close player menu", true);
    if (close != null && !tap(close[0], close[1])) return false;
    return waitForUi(new Condition() {
      @Override public boolean matches() {
        AccessibilityNodeInfo window = ui.getRootInActiveWindow();
        return findVisibleLabel(window, "Close player menu", true) == null
          && findVisibleLabel(window, "Open player menu", true) != null;
      }
    });
  }

  private int[] rendererOption(AccessibilityNodeInfo node, String style, boolean selected) {
    if (node == null) return null;
    String title = style.equals("amll") ? "AMLL" : "Spicy Lyrics";
    String label = title + " lyrics renderer";
    String desc = String.valueOf(node.getContentDescription());
    String text = String.valueOf(node.getText());
    boolean named = desc.equals(label) || desc.equals(label + ", selected")
      || text.equals(label) || text.equals(label + ", selected")
      || (node.isClickable() && text.equals(title));
    boolean active = node.isSelected() || desc.equals(label + ", selected") || text.equals(label + ", selected");
    if (named && selected == active && node.isVisibleToUser() && PKG.equals(String.valueOf(node.getPackageName()))) {
      Rect bounds = new Rect();
      node.getBoundsInScreen(bounds);
      if (!bounds.isEmpty()) return new int[] { bounds.centerX(), bounds.centerY() };
    }
    for (int i = 0; i < node.getChildCount(); i++) {
      int[] option = rendererOption(node.getChild(i), style, selected);
      if (option != null) return option;
    }
    return null;
  }

  private void footerStyleSwitchEvidence(boolean portrait) throws IOException {
    boolean menuClosed = closePlayerMenu();
    boolean seeded = fx("spicy") && fx("credits");
    shot("71-footer-spicy-BEFORE");
    boolean initialLink = portrait && seeded && targetedTap("link", "credits", false, "71-footer-initial-spicy");
    shot("71-footer-spicy-AFTER-INITIAL-TAP");
    boolean sequenceComplete = initialLink && menuClosed;
    // Real menu interactions and scroll only from here. Each native probe and
    // callback independently confirms the same credits track and current style.
    String previous = "spicy";
    for (String style : new String[] { "amll", "spicy" }) {
      final String oldStyle = previous;
      int[] menu = findVisibleLabel(ui.getRootInActiveWindow(), "Open player menu", true);
      boolean opened = menu != null && tap(menu[0], menu[1]);
      boolean rendered = opened && waitForUi(new Condition() {
        @Override public boolean matches() {
          AccessibilityNodeInfo window = ui.getRootInActiveWindow();
          return findVisibleLabel(window, "Close player menu", true) != null
            && rendererOption(window, oldStyle, true) != null && rendererOption(window, style, false) != null;
        }
      });
      if (rendered) sleep(500);
      int[] option = rendered ? rendererOption(ui.getRootInActiveWindow(), style, false) : null;
      boolean tapped = option != null && tap(option[0], option[1]);
      boolean selected = tapped && waitForUi(new Condition() {
        @Override public boolean matches() {
          AccessibilityNodeInfo window = ui.getRootInActiveWindow();
          return rendererOption(window, style, true) != null && rendererOption(window, oldStyle, false) != null;
        }
      });
      shot("71-footer-menu-" + style);
      boolean closed = closePlayerMenu();
      shot("71-footer-" + style + "-AFTER-SWITCH");
      boolean link = portrait && seeded && selected && closed
        && targetedTap("link", style.equals("amll") ? "credits-amll" : "credits", false, "71-footer-switch-" + style);
      shot("71-footer-" + style + "-AFTER-TAP");
      sequenceComplete &= link;
      step("credits-link-style-switch-" + style, sequenceComplete,
        "initialTap=" + initialLink + " menuOpened=" + opened + " optionsRendered=" + rendered
        + " optionTapped=" + tapped + " selected=" + selected + " closed=" + closed + " sameTrackMakerCallback=" + link
        + ". Review 71-footer PNGs");
      previous = style;
    }
  }
  private void step(String name, boolean evidence, String note) {
    if (!evidence && (remainingGates || name.equals("cold-launch") || name.startsWith("state-")
      || name.startsWith("seek-tap-") || name.startsWith("credits-link-") || name.equals("orientation-portrait"))) {
      failures.add(name + ": " + note);
    }
    summary.append(name).append(" | executed=").append(evidence).append(" | ").append(note).append('\n');
    log("STEP " + name + " executed=" + evidence + " " + note);
  }

  private void seekAndMakerEvidence() throws IOException {
    for (int rotation : new int[] { UiAutomation.ROTATION_FREEZE_0, UiAutomation.ROTATION_FREEZE_90 }) {
      boolean orientationOk = orient(rotation);
      boolean landscape = rotation == UiAutomation.ROTATION_FREEZE_90;
      String orientation = landscape ? "landscape" : "portrait";
      for (String style : new String[] { "spicy", "amll" }) {
        String stage = orientation + "-" + style;
        boolean ack = fx(style) && fx("pause");
        shot("50-preseek-" + stage);
        boolean ok = orientationOk && ack && targetedTap("seek", style, landscape, "50-seek-" + stage);
        shot("50-postseek-" + stage);
        step("seek-tap-" + stage, ok, "Measured rotation and exact native seek/store callback required");
      }
      for (String style : new String[] { "spicy", "amll" }) {
        String fixture = style.equals("amll") ? "credits-amll" : "credits";
        String stage = orientation + "-" + fixture;
        // Both credits fixtures share an ID. Change tracks before staging end credits.
        boolean ack = fx(style) && fx(fixture);
        if (ack) sleep(1500);
        shot("60-credits-" + stage);
        boolean ok = orientationOk && ack && targetedTap("link", fixture, landscape, "60-maker-" + stage);
        shot("60-credits-after-" + stage);
        step("credits-link-" + stage, ok, "Measured rotation and exact native maker LINK_OPEN/LINK_OK required");
      }
    }
  }

  private boolean homeWindowVisible() {
    AccessibilityNodeInfo window = ui.getRootInActiveWindow();
    return window != null && window.getPackageName() != null && !PKG.contentEquals(window.getPackageName());
  }

  private void remainingLifecycleEvidence() throws IOException {
    PowerManager power = (PowerManager) getTargetContext().getSystemService(Context.POWER_SERVICE);
    int[] rotations = { UiAutomation.ROTATION_FREEZE_90, UiAutomation.ROTATION_FREEZE_270, UiAutomation.ROTATION_FREEZE_0 };
    int[] angles = { 90, 270, 0 };
    for (String style : new String[] { "spicy", "amll" }) {
      boolean ack = fx(style) && fx("pause");
      boolean portrait = false;
      for (int i = 0; i < rotations.length; i++) {
        String name = "20-rot" + angles[i] + "-" + style;
        boolean rotated = orient(rotations[i]);
        boolean target = ack && rotated && nativeEvidence("seek", style, angles[i] != 0, name, false);
        shot(name);
        step("rotation-" + angles[i] + "-" + style, rotated && target, "Display angle and native app window/target measured. Review " + name + ".png");
        if (angles[i] == 0) portrait = rotated;
      }
      shellChecked("input keyevent KEYCODE_HOME");
      boolean home = waitForUi(new Condition() {
        @Override public boolean matches() { return homeWindowVisible(); }
      });
      shot("30-home-" + style);
      boolean resumed = launch("expolyrics://") && waitForPlayer(style, false);
      shot("30-resume-" + style);
      boolean homeTarget = ack && portrait && resumed && nativeEvidence("seek", style, false, "30-resume-" + style, false);
      step("home-resume-" + style, home && resumed && homeTarget,
        "App left foreground and returned to the same fixture with a measured target. Review 30-home/30-resume PNGs");

      boolean interactiveBefore = power.isInteractive();
      boolean asleep = false;
      try {
        shellChecked("input keyevent KEYCODE_SLEEP");
        asleep = waitForPower(power, false);
        if (asleep) {
          sleep(1200);
          asleep = !power.isInteractive();
        }
      } finally {
        long deadline = scenarioDeadline;
        scenarioDeadline = Long.MAX_VALUE;
        try {
          shellChecked("input keyevent KEYCODE_WAKEUP && wm dismiss-keyguard");
        } finally {
          scenarioDeadline = deadline;
        }
      }
      boolean interactiveAfter = waitForPower(power, true);
      boolean wakePlayer = waitForPlayer(style, false);
      shot("31-screenoff-wake-" + style);
      boolean wakeTarget = ack && portrait && wakePlayer && nativeEvidence("seek", style, false, "31-wake-" + style, false);
      save("31-power-" + style + ".txt", "interactiveBefore=" + interactiveBefore + "\nobservedAsleep=" + asleep
        + "\ninteractiveAfter=" + interactiveAfter + "\nplayerReturned=" + wakePlayer + "\nnativeTarget=" + wakeTarget + "\n"
        + shell("dumpsys power"));
      step("surface-sleep-wake-" + style, interactiveBefore && asleep && interactiveAfter && wakePlayer && wakeTarget,
        "Observed interactive/off/interactive with the same fixture restored. Review 31-screenoff-wake PNG and 31-power report");
    }
  }

  private void broadEvidence() throws IOException {
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
  }

  private void captureCrashEvidence() throws IOException {
    String lc = shell("logcat -d -v threadtime");
    save("logcat-full.txt", lc);
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
  }

  private static String stackTrace(Throwable failure) {
    StringWriter text = new StringWriter();
    failure.printStackTrace(new PrintWriter(text));
    return text.toString();
  }

  @Override public void onStart() {
    status(1, null);
    long started = SystemClock.elapsedRealtime();
    String run = "run-" + System.currentTimeMillis() + "-" + UUID.randomUUID().toString().substring(0, 8);
    String output = EXPORT_ROOT + "/" + run;
    boolean exported = false;
    Throwable error = null;
    if (remainingGates) scenarioDeadline = started + 12 * 60 * 1000L;
    try {
      File ext = getTargetContext().getExternalFilesDir(null);
      root = new File(new File(ext != null ? ext : getTargetContext().getFilesDir(), "fullapp"), run);
      if (!root.mkdirs()) throw new IOException("Cannot create evidence directory " + root);
      proto = new PrintWriter(new FileWriter(new File(root, "protocol.log")));
      summary.append("remainingGates=").append(remainingGates).append("\nexportDirectory=").append(output).append('\n');
      ui = getUiAutomation();
      AccessibilityServiceInfo si = ui.getServiceInfo();
      si.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
      ui.setServiceInfo(si);
      String sz = shell("wm size; wm density; getprop ro.build.version.sdk; getprop ro.product.model");
      save("device.txt", sz);
      log("DEVICE " + sz.replace('\n', ' '));
      saveSettings();
      for (String k : new String[] { "animator_duration_scale", "transition_animation_scale", "window_animation_scale" }) {
        shell("settings put global " + k + " 1");
      }
      shell("settings put system accelerometer_rotation 0; settings put system font_scale 1.0; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard");
      shell("logcat -b all -c");
      boolean up = bootstrapEmbeddedBundle();
      sleep(1500);
      appPid();
      step("cold-launch", up, "See 00-embedded-bootstrap.txt for launch, readiness, and player evidence");
      shot("00-launch");
      if (!up) throw new IOException("Embedded fixture bootstrap failed; no UI scenarios executed");
      settingsRouteEvidence();
      seekAndMakerEvidence();
      if (remainingGates) {
        boolean portrait = orient(UiAutomation.ROTATION_FREEZE_0);
        step("orientation-portrait", portrait, "Portrait display measured before same-track footer switch");
        footerStyleSwitchEvidence(portrait);
        remainingLifecycleEvidence();
      } else {
        broadEvidence();
      }
    } catch (Throwable t) {
      error = t;
    } finally {
      scenarioDeadline = Long.MAX_VALUE;
      if (ui != null && proto != null) {
        try {
          save("logcat-reactnativejs.txt", rn());
          captureCrashEvidence();
        } catch (Throwable t) {
          if (error == null) error = t;
          else error.addSuppressed(t);
        }
        restoreSettings();
      }
      if (!failures.isEmpty()) {
        IOException gates = new IOException("Hard failures: " + failures);
        if (error == null) error = gates;
        else error.addSuppressed(gates);
      }
      if (proto != null) {
        log("SCENARIOS elapsedMs=" + (SystemClock.elapsedRealtime() - started) + " failures=" + failures);
        if (proto.checkError()) {
          IOException protocolError = new IOException("Could not finish writing protocol.log");
          if (error == null) error = protocolError;
          else error.addSuppressed(protocolError);
        }
        proto.close();
        try {
          if (error != null) {
            save("RUNNER-ERROR.txt", stackTrace(error));
            summary.append("Runner error: ").append(error).append('\n');
          }
          summary.append("Hard gate failures: ").append(failures).append("\nEvidence files:\n");
          for (File file : evidenceFiles()) summary.append(file.getName()).append('\n');
          summary.append("SUMMARY.txt\nexport-verification.txt (written after mirror verification)\n");
          save("SUMMARY.txt", summary.toString());
        } catch (Throwable t) {
          if (error == null) error = t;
          else error.addSuppressed(t);
        }
      }
      try {
        if (ui == null || root == null || !root.isDirectory()) throw new IOException("Evidence export could not start");
        exportEvidence(output);
        exported = true;
      } catch (Throwable t) {
        Log.e("KineSyncFullApp", "Evidence export failed at " + output, t);
        if (error == null) error = t;
        else error.addSuppressed(t);
      }
    }
    Bundle result = new Bundle();
    result.putInt("tests", 1);
    result.putString("output", output);
    result.putBoolean("evidenceExported", exported);
    result.putString("privateOutput", String.valueOf(root));
    if (error == null) {
      status(0, null);
      result.putString("stream", "\nOK (1 test). Review the exported screenshots for visual evidence.\n");
      finish(android.app.Activity.RESULT_OK, result);
    } else {
      String st = stackTrace(error);
      status(-2, st);
      result.putString("stream", st);
      result.putString("shortMsg", error.toString());
      finish(android.app.Activity.RESULT_CANCELED, result);
    }
  }
}
