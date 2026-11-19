package dev.kineticron.fullapp;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.graphics.Point;
import android.graphics.Rect;
import android.graphics.SurfaceTexture;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.*;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;
import java.util.regex.*;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Full-app UI runner. Drives the REAL KineSync app (test build) via deep-link fixture states.
 *  Evidence only: every step records files; nothing is marked pass from command success alone. */
public final class FullAppRunner extends Instrumentation {
  private static final String ISOLATED_PACKAGE = "dev.kineticron.KineSync.testnov18";
  private static final String ISOLATED_RUNNER = "dev.kineticron.fullapp.testnov18";
  private static final int PIXEL_COLD_TRIALS = 6;
  private static final String COLD_FACTOR_ORDER = "BGGBBG";
  private static final int PIXEL_BURST_PRESENTS = 4;
  private static final int PIXEL_GEOMETRY_VALUES = 39;
  private static final String RUST_LYRICS_VIEW = "dev.kineticron.rustlyrics.KineSyncRustLyricsView";
  private String PKG = "dev.kineticron.KineSync";
  private static final String MAIN_ACTIVITY = "dev.kineticron.KineSync.MainActivity";
  private static final String EXPORT_ROOT = "/sdcard/Download/kinesync-fullapp-nov18";
  private static final String MAKER_URL = "https://example.com/maker";
  private static final String DEV_MENU_INTRO =
    "This is the developer menu. It gives you access to useful tools in your development builds.";
  private UiAutomation ui;
  private File root;
  private PrintWriter proto;
  private boolean remainingGates;
  private boolean pixelDiagOnly;
  private boolean pixelColdRepro;
  private boolean pixelColdFactorial;
  private boolean pixelPersistent;
  private int pixelBurstId;
  private int pixelColdTrial;
  private int pixelCaptureId = 173;
  private long pixelColdSeedNs;
  private int pixelScreenshotTexture;
  private int pixelScreenshotWidth, pixelScreenshotHeight;
  private long pixelScreenshotNs;
  // Accessed on the app main thread only.
  private Activity pixelActivity;
  private long scenarioDeadline = Long.MAX_VALUE;
  private int requestNumber;
  private int W = 1080, H = 2400;
  private final StringBuilder summary = new StringBuilder();
  private final List<String> failures = new ArrayList<>();
  private final List<File> pixelExportFiles = new ArrayList<>();
  private void status(int code, String stack) {
    Bundle b = new Bundle(); b.putString("id", "InstrumentationTestRunner"); b.putInt("numtests", 1); b.putInt("current", 1);
    b.putString("class", "dev.kineticron.fullapp.FullAppRunner"); b.putString("test", "fullAppEvidence");
    if (stack != null) { b.putString("stack", stack); b.putString("stream", stack); }
    sendStatus(code, b);
  }

  @Override public void onCreate(Bundle b) {
    super.onCreate(b);
    if (b != null && Boolean.parseBoolean(b.getString("isolatedBlueStacks"))) {
      PKG = ISOLATED_PACKAGE;
    }
    remainingGates = b != null && Boolean.parseBoolean(b.getString("remainingGates"));
    pixelColdFactorial = b != null && Boolean.parseBoolean(b.getString("pixelColdFactorial"));
    pixelColdRepro = pixelColdFactorial || (b != null && Boolean.parseBoolean(b.getString("pixelColdRepro")));
    pixelPersistent = b != null && Boolean.parseBoolean(b.getString("pixelPersistent"));
    pixelDiagOnly = pixelColdRepro || pixelPersistent || (b != null && Boolean.parseBoolean(b.getString("pixelDiagOnly")));
    if (pixelColdRepro) {
      String trial = b.getString("pixelColdTrial", "");
      if (trial.matches("[1-" + PIXEL_COLD_TRIALS + "]")) {
        pixelColdTrial = Integer.parseInt(trial);
        if (pixelColdTrial % 2 == 0) pixelCaptureId += pixelColdTrial / 2;
      }
    }
    if (pixelPersistent && b.getString("pixelBurstId", "").matches("[0-9]{3}")) {
      pixelBurstId = Integer.parseInt(b.getString("pixelBurstId"));
      pixelCaptureId = pixelBurstId;
    }
    start();
  }

  @Override public void callActivityOnResume(Activity activity) {
    super.callActivityOnResume(activity);
    if (pixelDiagOnly && MAIN_ACTIVITY.equals(activity.getClass().getName()) &&
        ISOLATED_PACKAGE.equals(activity.getPackageName())) pixelActivity = activity;
  }

  @Override public void callActivityOnPause(Activity activity) {
    if (pixelActivity == activity) pixelActivity = null;
    super.callActivityOnPause(activity);
  }

  private String shell(String cmd) throws IOException {
    return shell(cmd, false);
  }

  private String shellChecked(String cmd) throws IOException {
    return shell(cmd, true);
  }

  private String shell(String cmd, boolean checked) throws IOException {
    if (SystemClock.elapsedRealtime() >= scenarioDeadline) {
      throw new IOException(pixelColdRepro ? "Cold pixel trial time budget exceeded" : "Remaining gates time budget exceeded");
    }
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
    File[] files = pixelDiagOnly ? pixelExportFiles.toArray(new File[0]) : evidenceFiles();
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
    if (pixelDiagOnly) return;
    save("export-verification.txt", "Verified shell byte lengths\n" + lengths + "\n" + listing);
    mirrorFile(new File(root, "export-verification.txt"), path + "/export-verification.txt");
  }
  private void log(String s) { proto.println(android.os.SystemClock.elapsedRealtime() + " " + s); proto.flush(); }
  private int count(String hay, String needle) { int c = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { c++; i += needle.length(); } return c; }
  private String rn() throws IOException {
    String pidFilter = pixelDiagOnly ? " --pid=" + android.os.Process.myPid() : "";
    return shell((pixelColdRepro ? "timeout 5 " : "") + "logcat -d" + pidFilter + " -s ReactNativeJS:I");
  }

  private void shot(String name) throws IOException {
    screenshot(name);
    save(name + "-a11y.txt", tree());
    save(name + "-focus.txt", "pid=" + appPid() + "\n" + shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'") + shell("dumpsys activity top | grep -E 'ACTIVITY|Hosting|mFocused' | head -8") + "\n" + shell("dumpsys SurfaceFlinger --list"));
  }

  private void screenshot(String name) throws IOException {
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
    String command = (remainingGates || pixelColdRepro ? "timeout 15 " : "") + "am start" + (wait ? " -W" : "");
    String out = shell(command + " -a android.intent.action.VIEW -d '" + url + "' -n " + PKG + "/" + MAIN_ACTIVITY);
    boolean started = wait ? out.contains("Status: ok") || out.contains("Complete")
      : out.contains("Starting: Intent") && !out.contains("Error");
    if (pixelDiagOnly) log("PIXEL_FIXTURE_LAUNCH success=" + started);
    else log("AMSTART " + url + " -> " + out.replace('\n', ' '));
    return started;
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

  private boolean initialPixelFixture() throws IOException {
    String request = "pixel-credits-" + SystemClock.elapsedRealtime();
    if (pixelColdRepro) {
      pixelColdSeedNs = System.nanoTime();
      log("PIXEL_COLD_SEED request=" + request + " launchNs=" + pixelColdSeedNs);
    }
    if (!launch("expolyrics://?fx=credits-amll&request=" + request, !pixelColdRepro)) return false;
    Pattern expected = Pattern.compile("KSFX ACK fx=credits-amll style=amll lines=[1-9][0-9]* playing=false pos=51600"
      + " request=" + request + " source=event track=fx-track-credits title=\"Fixture credits\""
      + " connection=connected mode=desktop appOnboardingVisible=false tourActive=false\\s*$", Pattern.MULTILINE);
    boolean acknowledged = expected.matcher(awaitLog(expected, 15)).find();
    log("PIXEL_FIXTURE_ACK request=" + request + " confirmed=" + acknowledged);
    return acknowledged;
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
  private AccessibilityNodeInfo clickableAppDescription(AccessibilityNodeInfo node, String label) {
    if (node == null) return null;
    if (PKG.equals(String.valueOf(node.getPackageName())) && node.isVisibleToUser() && node.isClickable()
        && node.isEnabled() && label.equals(String.valueOf(node.getContentDescription()))) {
      return node;
    }
    for (int i = 0; i < node.getChildCount(); i++) {
      AccessibilityNodeInfo button = clickableAppDescription(node.getChild(i), label);
      if (button != null) return button;
    }
    return null;
  }

  private boolean developerOverlayVisible(AccessibilityNodeInfo window) {
    return findVisibleLabel(window, DEV_MENU_INTRO, false) != null
      || (findVisibleLabel(window, "Reload", false) != null
        && findVisibleLabel(window, "Go home", false) != null);
  }

  private boolean waitForOverlayFreeWindow(String fixture) {
    return waitForUi(new Condition() {
      private boolean closeRequested;

      @Override public boolean matches() {
        AccessibilityNodeInfo window = ui.getRootInActiveWindow();
        if (window == null) return false;
        if (!developerOverlayVisible(window)) return fixture == null || playerIdentity(window, fixture);
        int[] close = findVisibleLabel(window, "Close", true);
        if (close != null && !closeRequested) {
          closeRequested = true;
          log("DEV_MENU_CLOSE_DURING_SCENARIO inputTap=" + tap(close[0], close[1]));
        }
        return false;
      }
    });
  }

  private boolean playerIdentity(AccessibilityNodeInfo window, String fixture) {
    String title = "Fixture " + fixture;
    return window != null && window.getPackageName() != null && PKG.contentEquals(window.getPackageName())
      && findVisibleLabel(window, "Open player menu", true) != null
      && (findVisibleLabel(window, title, false) != null
        || findVisibleLabel(window, title + ", KineSync Test. Show album artwork", true) != null)
      && findVisibleLabel(window, "Close", true) == null
      && findVisibleLabel(window, "Close player menu", true) == null
      && !developerOverlayVisible(window);
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
      boolean playerVisible = pixelDiagOnly && findVisibleLabel(window, "Open player menu", true) != null;
      boolean clear = (appVisible || playerVisible) && !onboarding && next == null && !regularMenu && close == null
        && (!continued || closed);
      clearSamples = clear ? clearSamples + 1 : 0;
      if (clearSamples >= (pixelColdRepro ? 1 : 3)) {
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
    String out = shell((remainingGates || pixelColdRepro ? "timeout 15 " : "")
      + "am start -W -a android.intent.action.MAIN -n " + PKG + "/" + MAIN_ACTIVITY);
    if (!pixelDiagOnly) log("EMBEDDED_BOOTSTRAP_LAUNCH " + out.replace('\n', ' '));
    boolean started = out.contains("Status: ok");
    log("ANDROID_LAUNCH_SUCCESS=" + started);
    int[] button = null;
    boolean ready = false, setup = false, dismissed = false, seedReady = false, player = false;
    for (int i = 0; started && i < 60 && button == null && !ready; i++) {
      button = findVisibleLabel(ui.getRootInActiveWindow(), "Load embedded bundle", false);
      if (pixelDiagOnly && button == null) ready = rn().contains("KSFX READY bundle=embedded");
      if (button == null && (!pixelColdRepro || !ready)) sleep(500);
    }
    if (!pixelDiagOnly) shot("00-embedded-launcher");
    if (button != null) {
      log("EMBEDDED_BOOTSTRAP_TAP x=" + button[0] + " y=" + button[1]);
      shell("input tap " + button[0] + " " + button[1]);
      ready = waitFor("KSFX READY bundle=embedded", 0, 60);
    }
    log("EMBEDDED_ASSET_READY=" + ready);
    if (ready) {
      if (!pixelDiagOnly) shot("00-devmenu-before");
      setup = waitFor("KSFX APP_SETUP_READY ", 0, 30);
      log("APP_SETUP_READY=" + setup);
      if (setup) dismissed = dismissDevMenu();
      if (!pixelDiagOnly) shot("00-devmenu-after");
    }
    log("EXPO_ONBOARDING_DISMISSED=" + dismissed);
    if (pixelColdRepro) return dismissed;
    if (dismissed) seedReady = pixelDiagOnly ? initialPixelFixture() : initialSpicyFixture();
    log("INITIAL_SEED_READY=" + seedReady);
    for (int i = 0; seedReady && i < 30 && !player; i++) {
      player = playerIdentity(ui.getRootInActiveWindow(), pixelDiagOnly ? "credits" : "spicy");
      if (!player) sleep(500);
    }
    log("PLAYER_IDENTITY=" + player);
    if (!pixelDiagOnly) {
      save("00-embedded-bootstrap.txt", "started=" + started + " embeddedButton=" + (button != null)
        + " ready=" + ready + " appSetupReady=" + setup + " expoOnboardingDismissed=" + dismissed
        + " seedReady=" + seedReady + " playerIdentity=" + player + "\n" + tree() + "\n" + rn());
    }
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
      shot(prefix + (rawReturnTarget ? "-AFTER-RESEEDED" : "-AFTER-RESEED-SKIPPED"));
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
    if (!waitForOverlayFreeWindow(null)) return false;
    AccessibilityNodeInfo close = clickableAppDescription(ui.getRootInActiveWindow(), "Close player menu");
    if (close != null && !close.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return false;
    return waitForUi(new Condition() {
      @Override public boolean matches() {
        AccessibilityNodeInfo window = ui.getRootInActiveWindow();
        return !developerOverlayVisible(window) && findVisibleLabel(window, "Close player menu", true) == null
          && clickableAppDescription(window, "Open player menu") != null;
      }
    });
  }

  private AccessibilityNodeInfo rendererOption(AccessibilityNodeInfo window, String style, boolean selected) {
    String title = style.equals("amll") ? "AMLL" : "Spicy Lyrics";
    return clickableAppDescription(window, title + " lyrics renderer" + (selected ? ", selected" : ""));
  }

  private boolean chooserState(AccessibilityNodeInfo window, String selected, String unselected) {
    return !developerOverlayVisible(window)
      && findVisibleLabel(window, "Settings", false) != null
      && findVisibleLabel(window, "Close player menu", true) != null
      && rendererOption(window, selected, true) != null
      && rendererOption(window, unselected, false) != null;
  }

  private boolean openPlayerMenu() {
    AccessibilityNodeInfo window = ui.getRootInActiveWindow();
    AccessibilityNodeInfo menu = developerOverlayVisible(window) ? null : clickableAppDescription(window, "Open player menu");
    // Expo's floating control overlaps the player menu on the Moto capture.
    return menu != null && menu.performAction(AccessibilityNodeInfo.ACTION_CLICK);
  }

  private boolean selectStyle(String previous, String style) {
    AccessibilityNodeInfo window = ui.getRootInActiveWindow();
    if (!chooserState(window, previous, style)) return false;
    AccessibilityNodeInfo option = rendererOption(window, style, false);
    return option != null && option.performAction(AccessibilityNodeInfo.ACTION_CLICK);
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
      boolean opened = seeded && !oldStyle.equals(style) && closePlayerMenu() && openPlayerMenu();
      boolean rendered = opened && waitForUi(new Condition() {
        @Override public boolean matches() {
          return chooserState(ui.getRootInActiveWindow(), oldStyle, style);
        }
      });
      boolean tapped = rendered && selectStyle(oldStyle, style);
      boolean selected = tapped && waitForUi(new Condition() {
        @Override public boolean matches() {
          return chooserState(ui.getRootInActiveWindow(), style, oldStyle);
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
      if (selected) previous = style;
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
      boolean clearBeforeHome = waitForOverlayFreeWindow(style);
      shellChecked("input keyevent KEYCODE_HOME");
      boolean home = waitForUi(new Condition() {
        @Override public boolean matches() { return homeWindowVisible(); }
      });
      shot("30-home-" + style);
      boolean resumed = launch("expolyrics://") && waitForOverlayFreeWindow(style);
      shot("30-resume-" + style);
      boolean homeTarget = ack && portrait && resumed && nativeEvidence("seek", style, false, "30-resume-" + style, false);
      step("home-resume-" + style, clearBeforeHome && home && resumed && homeTarget,
        "overlayFreePlayerBeforeHome=" + clearBeforeHome + " home=" + home + " overlayFreePlayerResumed=" + resumed
        + " nativeTarget=" + homeTarget + ". Review 30-home/30-resume PNGs");

      boolean clearBeforeSleep = waitForOverlayFreeWindow(style);
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
      boolean wakePlayer = waitForOverlayFreeWindow(style);
      shot("31-screenoff-wake-" + style);
      boolean wakeTarget = ack && portrait && wakePlayer && nativeEvidence("seek", style, false, "31-wake-" + style, false);
      save("31-power-" + style + ".txt", "overlayFreePlayerBeforeSleep=" + clearBeforeSleep
        + "\ninteractiveBefore=" + interactiveBefore + "\nobservedAsleep=" + asleep
        + "\ninteractiveAfter=" + interactiveAfter + "\nplayerReturned=" + wakePlayer + "\nnativeTarget=" + wakeTarget + "\n"
        + shell("dumpsys power"));
      step("surface-sleep-wake-" + style, clearBeforeSleep && interactiveBefore && asleep && interactiveAfter && wakePlayer && wakeTarget,
        "overlayFreePlayerBeforeSleep=" + clearBeforeSleep + " overlayFreePlayerAfterWake=" + wakePlayer
        + " nativeTarget=" + wakeTarget + ". Review 31-screenoff-wake PNG and 31-power report");
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
    boolean opened = fx("spicy") && closePlayerMenu() && openPlayerMenu();
    boolean rendered = opened && waitForUi(new Condition() {
      @Override public boolean matches() {
        return chooserState(ui.getRootInActiveWindow(), "spicy", "amll");
      }
    });
    shot("70-menu-open");
    boolean amll = rendered && selectStyle("spicy", "amll")
      && waitForUi(new Condition() {
        @Override public boolean matches() {
          return chooserState(ui.getRootInActiveWindow(), "amll", "spicy");
        }
      });
    shot("70-menu-amll");
    boolean spicy = amll && selectStyle("amll", "spicy")
      && waitForUi(new Condition() {
        @Override public boolean matches() {
          return chooserState(ui.getRootInActiveWindow(), "spicy", "amll");
        }
      });
    shot("70-menu-spicy");
    boolean closed = closePlayerMenu();
    step("settings-renderer-switch", spicy && closed,
      "menuOpened=" + opened + " optionsRendered=" + rendered + " amllSelected=" + amll
      + " spicySelected=" + spicy + " closed=" + closed);
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

  private JSONObject matchingPixelReceipt(File receipt) throws IOException {
    if (!Files.isRegularFile(receipt.toPath(), LinkOption.NOFOLLOW_LINKS)) return null;
    try {
      JSONObject metadata = new JSONObject(new String(Files.readAllBytes(receipt.toPath()), StandardCharsets.UTF_8));
      return metadata.optInt("capture") == pixelCaptureId && metadata.optInt("frame") == 1
        ? metadata : null;
    } catch (JSONException incomplete) {
      // Kotlin writes the sidecar just before it logs the corresponding update.
      return null;
    }
  }

  private boolean finiteNumbers(JSONArray array, int length) {
    if (array == null || array.length() != length) return false;
    for (int i = 0; i < length; i++) {
      if (!(array.opt(i) instanceof Number) || !Double.isFinite(array.optDouble(i))) return false;
    }
    return true;
  }

  private boolean validBurstHistory(JSONObject receipt) {
    JSONArray history = receipt.optJSONArray("presentHistory");
    JSONArray geometry = receipt.optJSONArray("geometry");
    if (receipt.optInt("presentOrdinal") != PIXEL_BURST_PRESENTS || !finiteNumbers(geometry, PIXEL_GEOMETRY_VALUES) ||
        !(receipt.opt("holdUntilNs") instanceof Number) || history == null || history.length() != PIXEL_BURST_PRESENTS) return false;
    long priorBufferNs = 0;
    long priorObservedNs = 0;
    String[] numbers = { "ordinal", "submission", "session", "generation", "texture", "beforeNs", "bufferNs",
      "beforeUpdates", "updates", "submittedNs", "workerDoneNs", "observedNs" };
    for (int i = 0; i < PIXEL_BURST_PRESENTS; i++) {
      JSONObject visit = history.optJSONObject(i);
      if (visit == null || visit.length() != numbers.length + 1) return false;
      for (String key : numbers) if (!(visit.opt(key) instanceof Number)) return false;
      JSONArray visitGeometry = visit.optJSONArray("geometry");
      long beforeNs = visit.optLong("beforeNs"), bufferNs = visit.optLong("bufferNs");
      long submittedNs = visit.optLong("submittedNs"), workerDoneNs = visit.optLong("workerDoneNs");
      long observedNs = visit.optLong("observedNs");
      if (visit.optInt("ordinal") != i + 1 || visit.optLong("submission") != i + 1 ||
          visit.optLong("session") != receipt.optLong("session") || visit.optLong("generation") != receipt.optLong("generation") ||
          visit.optInt("texture") != receipt.optInt("texture") || beforeNs < 0 || bufferNs <= beforeNs ||
          (i > 0 && beforeNs != priorBufferNs) || visit.optLong("updates") <= visit.optLong("beforeUpdates") ||
          submittedNs < priorObservedNs || workerDoneNs < submittedNs || observedNs < workerDoneNs ||
          !finiteNumbers(visitGeometry, PIXEL_GEOMETRY_VALUES) || visitGeometry.optInt(2) != receipt.optInt("width") ||
          visitGeometry.optInt(3) != receipt.optInt("height")) return false;
      if (i + 1 == PIXEL_BURST_PRESENTS && (bufferNs != receipt.optLong("bufferNs") ||
          !visitGeometry.toString().equals(geometry.toString()) || receipt.optLong("holdUntilNs") <= observedNs)) return false;
      priorBufferNs = bufferNs;
      priorObservedNs = observedNs;
    }
    return true;
  }

  private boolean validBurstLayout(JSONObject receipt) {
    int width = receipt.optInt("width"), height = receipt.optInt("height");
    JSONArray layout = receipt.optJSONArray("markerLayout");
    if (receipt.optInt("presentOrdinal") != PIXEL_BURST_PRESENTS || width < 320 || height < 240 ||
        !finiteNumbers(layout, 5)) return false;
    int cell = Math.min(36, Math.min(width / 20, height / 12));
    return layout.optDouble(0) == cell && layout.optDouble(1) == cell && layout.optDouble(2) == cell &&
      layout.optDouble(3) == width - 5 * cell && layout.optDouble(4) == height / 3;
  }

  private boolean validColdFirstReceipt(JSONObject receipt) {
    JSONArray geometry = receipt.optJSONArray("geometry");
    return finiteNumbers(geometry, PIXEL_GEOMETRY_VALUES) && geometry.optDouble(2) == receipt.optInt("width") &&
      geometry.optDouble(3) == receipt.optInt("height") && geometry.optDouble(4) == 1 &&
      receipt.opt("requestedRevision") instanceof Number && receipt.optLong("requestedRevision") > 0 &&
      receipt.opt("holdUntilNs") instanceof Number && receipt.optLong("holdUntilNs") > 0 &&
      receipt.opt("beforeNs") instanceof Number && receipt.optLong("beforeNs") >= 0 &&
      receipt.optLong("bufferNs") > receipt.optLong("beforeNs");
  }

  private static String pixelHash(File file) throws IOException {
    try (InputStream in = new FileInputStream(file)) {
      MessageDigest hash = MessageDigest.getInstance("SHA-256");
      byte[] bytes = new byte[32768];
      for (int n; (n = in.read(bytes)) != -1; ) hash.update(bytes, 0, n);
      return String.format(Locale.ROOT, "%064x", new BigInteger(1, hash.digest()));
    } catch (NoSuchAlgorithmException error) {
      throw new IOException("SHA-256 unavailable", error);
    }
  }

  private void copyPixelStage(File dir, String stage, List<File> matched) throws IOException {
    String base = "frame-1-" + stage;
    String metadataName = base + ".json";
    JSONObject metadata = matchingPixelReceipt(new File(dir, metadataName));
    if (metadata == null) throw new IOException("Missing matching pixel metadata for " + stage);
    boolean textureStage = stage.equals("textureview");
    if (pixelPersistent && !(textureStage ? validBurstHistory(metadata) : validBurstLayout(metadata))) {
      throw new IOException("Invalid burst metadata for " + stage);
    }
    if (pixelColdRepro && textureStage && !validColdFirstReceipt(metadata)) {
      throw new IOException("Invalid first-surface TextureView receipt");
    }
    for (String extension : new String[] { "raw", "png" }) {
      String name = base + "." + extension;
      File file = new File(dir, name);
      if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS) || file.length() == 0) {
        throw new IOException("Missing pixel artifact " + name);
      }
      File copy = new File(root, name);
      Files.copy(file.toPath(), copy.toPath(), LinkOption.NOFOLLOW_LINKS);
      if (!Files.isRegularFile(copy.toPath(), LinkOption.NOFOLLOW_LINKS) ||
          !pixelHash(copy).equals(metadata.optString(extension + "Sha256"))) {
        throw new IOException("Pixel hash mismatch for " + name);
      }
      matched.add(copy);
    }
    String[] keys = textureStage
      ? new String[] { "frame", "capture", "session", "generation", "texture", "bufferNs", "width", "height",
          "rawRowBytes", "config", "byteOrder", "colorSpace", "premultiplied", "rawSha256", "pngSha256" }
      : new String[] { "frame", "capture", "stage", "width", "height", "format", "rawRowBytes", "gpuCopyRowBytes",
          "rowOrder", "rawColorSpace", "rawAlpha", "pngColorSpace", "pngAlpha", "rawSha256", "pngSha256" };
    try {
      JSONObject allowed = new JSONObject(metadata, keys);
      if (pixelPersistent) {
        allowed.put("presentOrdinal", metadata.optInt("presentOrdinal"));
        if (textureStage) {
          allowed.put("presentHistory", metadata.optJSONArray("presentHistory")).put("geometry", metadata.optJSONArray("geometry"))
            .put("holdUntilNs", metadata.optLong("holdUntilNs"));
        } else {
          allowed.put("markerLayout", metadata.optJSONArray("markerLayout"));
        }
      }
      if (pixelColdRepro && textureStage) {
        allowed.put("geometry", metadata.optJSONArray("geometry")).put("holdUntilNs", metadata.optLong("holdUntilNs"))
          .put("requestedRevision", metadata.optLong("requestedRevision")).put("beforeNs", metadata.optLong("beforeNs"));
      }
      save(metadataName, allowed.toString());
    } catch (JSONException error) {
      throw new IOException("Cannot export pixel metadata for " + stage, error);
    }
    matched.add(new File(root, metadataName));
  }

  private void findPixelTextures(View view, List<TextureView> matches) {
    if (view instanceof TextureView && view.getParent() != null &&
        RUST_LYRICS_VIEW.equals(view.getParent().getClass().getName()) && view.isShown()) {
      matches.add((TextureView) view);
    }
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) findPixelTextures(group.getChildAt(i), matches);
    }
  }

  private Rect pixelViewport(JSONObject receipt, Point displaySize) {
    return pixelViewport(receipt, displaySize, null);
  }

  private boolean matchesHeldPixel(TextureView texture, SurfaceTexture surface, int[] origin, JSONObject receipt) {
    long bufferNs = receipt.optLong("bufferNs");
    long heldUntil = receipt.optLong("holdUntilNs");
    if (bufferNs <= 0 || surface.getTimestamp() != bufferNs || System.nanoTime() >= heldUntil) return false;
    JSONArray geometry = receipt.optJSONArray("geometry");
    if (!finiteNumbers(geometry, PIXEL_GEOMETRY_VALUES) || geometry.optDouble(0) != origin[0] ||
        geometry.optDouble(1) != origin[1] || geometry.optDouble(2) != texture.getWidth() ||
        geometry.optDouble(3) != texture.getHeight() || geometry.optDouble(4) != texture.getAlpha()) return false;
    float[] view = new float[9], content = new float[9], uv = new float[16];
    texture.getMatrix().getValues(view);
    texture.getTransform(new Matrix()).getValues(content);
    surface.getTransformMatrix(uv);
    int index = 5;
    for (float[] matrix : new float[][] {view, content, uv}) {
      for (float value : matrix) if (geometry.optDouble(index++) != value) return false;
    }
    return surface.getTimestamp() == bufferNs && System.nanoTime() < heldUntil;
  }

  private Rect pixelViewport(final JSONObject receipt, final Point displaySize, final int[] textureId) {
    final Rect bounds = new Rect();
    runOnMainSync(new Runnable() {
      @Override public void run() {
        if (pixelActivity == null || !pixelActivity.hasWindowFocus()) return;
        List<TextureView> matches = new ArrayList<>();
        findPixelTextures(pixelActivity.getWindow().getDecorView(), matches);
        if (matches.size() != 1) return;
        TextureView texture = matches.get(0);
        SurfaceTexture surface = texture.getSurfaceTexture();
        if (surface == null || !texture.getTransform(null).isIdentity() || texture.getDisplay() == null) return;
        for (View view = texture; view != null; ) {
          if (view.getAlpha() != 1f || !view.getMatrix().isIdentity()) return;
          view = view.getParent() instanceof View ? (View) view.getParent() : null;
        }
        int width = texture.getWidth(), height = texture.getHeight();
        if (receipt != null && (!receipt.has("texture") || receipt.optInt("texture") != System.identityHashCode(surface) ||
            receipt.optInt("width") != width || receipt.optInt("height") != height)) return;
        Rect visible = new Rect();
        Point offset = new Point();
        if (!texture.getGlobalVisibleRect(visible, offset) ||
            !visible.equals(new Rect(offset.x, offset.y, offset.x + width, offset.y + height))) return;
        int[] origin = new int[2];
        texture.getLocationOnScreen(origin);
        if ((pixelPersistent || pixelColdRepro) && receipt != null && !matchesHeldPixel(texture, surface, origin, receipt)) return;
        texture.getDisplay().getRealSize(displaySize);
        WindowInsets insets = texture.getRootWindowInsets();
        if (insets == null) return;
        Rect unobscured = new Rect(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
          displaySize.x - insets.getSystemWindowInsetRight(), displaySize.y - insets.getSystemWindowInsetBottom());
        Rect candidate = new Rect(origin[0], origin[1], origin[0] + width, origin[1] + height);
        if (!candidate.isEmpty() && unobscured.contains(candidate)) {
          bounds.set(candidate);
          if (textureId != null) textureId[0] = System.identityHashCode(surface);
        }
      }
    });
    return bounds;
  }

  private boolean pixelControlsClear() {
    AccessibilityNodeInfo window = ui.getRootInActiveWindow();
    return playerIdentity(window, "credits") && findVisibleLabel(window, "Play music", true) == null &&
      findVisibleLabel(window, "Pause playback", true) == null;
  }

  private File pixelScreenshot(String name, JSONObject receipt) throws IOException {
    Point display = new Point();
    int[] texture = new int[1];
    Rect bounds = pixelViewport(receipt, display, texture);
    if (bounds.isEmpty() || !pixelControlsClear()) throw new IOException("No unobstructed Rust viewport for " + name);
    long sampledNs = System.nanoTime();
    Bitmap screen = ui.takeScreenshot();
    if (screen == null) throw new IOException("Pixel screenshot unavailable: " + name);
    Bitmap crop = null;
    try {
      Point finalDisplay = new Point();
      int[] finalTexture = new int[1];
      if (screen.getWidth() != display.x || screen.getHeight() != display.y ||
          !bounds.equals(pixelViewport(receipt, finalDisplay, finalTexture)) || !display.equals(finalDisplay) ||
          texture[0] != finalTexture[0] ||
          bounds.equals(new Rect(0, 0, display.x, display.y)) || !pixelControlsClear()) {
        throw new IOException("Rust viewport changed or does not match screenshot coordinates: " + name);
      }
      if ((pixelPersistent || pixelColdRepro) && receipt != null) {
        log((pixelPersistent ? "PIXEL_BURST" : "PIXEL_COLD") + "_CROP_TIMESTAMPS capture=" + pixelCaptureId +
          " bufferNs=" + receipt.optLong("bufferNs") +
          " screenshotNs=" + sampledNs + " verifiedAfterNs=" + System.nanoTime());
      }
      crop = Bitmap.createBitmap(screen, bounds.left, bounds.top, bounds.width(), bounds.height());
      File file = new File(root, name + ".png");
      try (FileOutputStream out = new FileOutputStream(file)) {
        if (!crop.compress(Bitmap.CompressFormat.PNG, 100, out)) throw new IOException("Pixel crop encoding failed: " + name);
      }
      W = display.x;
      H = display.y;
      pixelScreenshotTexture = texture[0];
      pixelScreenshotWidth = bounds.width();
      pixelScreenshotHeight = bounds.height();
      pixelScreenshotNs = sampledNs;
      log("PIXEL_DIAG_CROP " + name + " x=" + bounds.left + " y=" + bounds.top +
        " size=" + bounds.width() + "x" + bounds.height());
      return file;
    } finally {
      if (crop != null && crop != screen) crop.recycle();
      screen.recycle();
    }
  }

  private void clearPixelReceipts(File dir) throws IOException {
    Files.deleteIfExists(new File(dir, "frame-1.ready").toPath());
    Files.deleteIfExists(new File(dir, "release").toPath());
    Files.deleteIfExists(new File(dir, "burst-present").toPath());
    Files.deleteIfExists(new File(dir, "burst-failed").toPath());
    Files.deleteIfExists(new File(dir, "cold-first").toPath());
    Files.deleteIfExists(new File(dir, "cold-first-failed").toPath());
    for (String stage : new String[] { "offscreen", "surface", "blit-proxy", "textureview" }) {
      for (String extension : new String[] { "raw", "png", "json" }) {
        Files.deleteIfExists(new File(dir, "frame-1-" + stage + "." + extension).toPath());
      }
    }
  }

  private void releasePixelHold(File dir) throws IOException {
    Files.write(new File(dir, "release").toPath(), Integer.toString(pixelCaptureId).getBytes(StandardCharsets.UTF_8));
    log("PIXEL_DIAG_RELEASE capture=" + pixelCaptureId);
  }

  private void publishPixelMarker(File markerFile, String marker) throws IOException {
    Path temporary = Files.createTempFile(markerFile.getParentFile().toPath(), markerFile.getName() + "-", ".tmp");
    try {
      Files.write(temporary, marker.getBytes(StandardCharsets.UTF_8));
      if (Files.exists(markerFile.toPath(), LinkOption.NOFOLLOW_LINKS)) throw new IOException("Existing pixel marker");
      Files.move(temporary, markerFile.toPath(), StandardCopyOption.ATOMIC_MOVE);
    } finally {
      Files.deleteIfExists(temporary);
    }
  }

  private void armPixelCapture(File arm) throws IOException {
    publishPixelMarker(arm, (pixelPersistent ? "burst " : "") + pixelCaptureId);
  }

  private File pixelDiagnosticDirectory() throws IOException {
    File dir = new File(getTargetContext().getFilesDir(), "rust-pixel-diag");
    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create " + dir);
    if (!Files.isDirectory(dir.toPath(), LinkOption.NOFOLLOW_LINKS)) {
      throw new IOException("Invalid pixel diagnostic directory");
    }
    File arm = new File(dir, "arm");
    if (Files.exists(arm.toPath(), LinkOption.NOFOLLOW_LINKS)) throw new IOException("Existing pixel capture arm marker");
    Files.deleteIfExists(new File(dir, "cold-factor").toPath());
    return dir;
  }

  private void recordPixelDevice() throws IOException {
    save("device.txt", "display=" + W + "x" + H + "\napi=" + Build.VERSION.SDK_INT
      + "\ndensityDpi=" + getTargetContext().getResources().getDisplayMetrics().densityDpi + "\n");
    pixelExportFiles.add(new File(root, "device.txt"));
  }

  private int decodeBurstOrdinal(Bitmap bitmap, int cell, int x, int y) {
    if (x < 0 || y < 0 || x + 4 * cell > bitmap.getWidth() || y + 4 * cell > bitmap.getHeight()) return 0;
    int bits = 0;
    for (int bit = 0; bit < 16; bit++) {
      int pixel = bitmap.getPixel(x + bit % 4 * cell + cell / 2, y + bit / 4 * cell + cell / 2);
      int r = (pixel >>> 16) & 255, g = (pixel >>> 8) & 255, b = pixel & 255;
      if ((pixel >>> 24) < 240) return 0;
      if (Math.min(r, Math.min(g, b)) >= 223) bits |= 1 << bit;
      else if (Math.max(r, Math.max(g, b)) > 32) return 0;
    }
    int payload = (bits >>> 4) & 2047;
    if ((bits & 15) != 13 || (payload & 255) != pixelCaptureId ||
        ((bits >>> 15) & 1) != (Integer.bitCount(payload) & 1)) return 0;
    int ordinal = payload >>> 8;
    return ordinal >= 1 && ordinal <= PIXEL_BURST_PRESENTS ? ordinal : 0;
  }

  private boolean recordBurstMarker(String stage, File file, JSONArray layout, int width, int height) throws IOException {
    Bitmap image = BitmapFactory.decodeFile(file.getPath());
    if (image == null) throw new IOException("Could not decode burst PNG for " + stage);
    try {
      if (image.getWidth() != width || image.getHeight() != height) throw new IOException("Burst size mismatch for " + stage);
      int cell = layout.optInt(0);
      int first = decodeBurstOrdinal(image, cell, layout.optInt(1), layout.optInt(2));
      int second = decodeBurstOrdinal(image, cell, layout.optInt(3), layout.optInt(4));
      log("PIXEL_BURST_MARKER capture=" + pixelCaptureId + " stage=" + stage + " firstOrdinal=" + first + " secondOrdinal=" + second);
      return (first == PIXEL_BURST_PRESENTS || second == PIXEL_BURST_PRESENTS) &&
        (first == 0 || first == PIXEL_BURST_PRESENTS) && (second == 0 || second == PIXEL_BURST_PRESENTS);
    } finally {
      image.recycle();
    }
  }

  private void recordBurstPairing(File dir, File composited) throws IOException {
    JSONObject surface = matchingPixelReceipt(new File(dir, "frame-1-surface.json"));
    JSONObject offscreen = matchingPixelReceipt(new File(dir, "frame-1-offscreen.json"));
    JSONObject texture = matchingPixelReceipt(new File(dir, "frame-1-textureview.json"));
    if (surface == null || offscreen == null || texture == null) throw new IOException("Missing direct burst receipts");
    int width = surface.optInt("width"), height = surface.optInt("height");
    if (offscreen.optInt("width") != width || offscreen.optInt("height") != height ||
        texture.optInt("width") != width || texture.optInt("height") != height) throw new IOException("Burst extent changed across stages");
    JSONArray layout = surface.optJSONArray("markerLayout");
    if (!recordBurstMarker("offscreen", new File(root, "frame-1-offscreen.png"), layout, width, height) ||
        !recordBurstMarker("surface", new File(root, "frame-1-surface.png"), layout, width, height)) {
      throw new IOException("Producer PNG did not contain the final burst marker");
    }
    boolean texturePaired = recordBurstMarker("textureview", new File(root, "frame-1-textureview.png"), layout, width, height);
    boolean compositorPaired = recordBurstMarker("composited", composited, layout, width, height);
    log("PIXEL_BURST_PAIRING capture=" + pixelCaptureId + " texturePaired=" + texturePaired + " compositorPaired=" + compositorPaired);
  }

  private void collectPixelStages(File dir, File composited) throws IOException {
    List<File> matched = new ArrayList<>();
    String bufferStage = pixelPersistent || new File(dir, "frame-1-surface.json").isFile() ? "surface" : "blit-proxy";
    if (pixelColdRepro) {
      JSONObject texture = matchingPixelReceipt(new File(dir, "frame-1-textureview.json"));
      if (texture == null) throw new IOException("First-surface TextureView receipt is missing");
      for (String stage : new String[] { "offscreen", bufferStage }) {
        JSONObject gpu = matchingPixelReceipt(new File(dir, "frame-1-" + stage + ".json"));
        if (gpu == null || gpu.optInt("width") != texture.optInt("width") ||
            gpu.optInt("height") != texture.optInt("height")) {
          throw new IOException("First-surface extent mismatch for " + stage);
        }
      }
    }
    copyPixelStage(dir, "offscreen", matched);
    copyPixelStage(dir, bufferStage, matched);
    copyPixelStage(dir, "textureview", matched);
    if (pixelPersistent) recordBurstPairing(dir, composited);
    matched.add(composited);
    pixelExportFiles.addAll(matched);
    summary.append("pixelCapture=").append(pixelCaptureId).append(" bufferStage=").append(bufferStage).append('\n');
    if (pixelColdRepro) log("PIXEL_DIAG_STAGES capture=" + pixelCaptureId + " bufferStage=" + bufferStage);
  }

  private void pixelDiagnosticEvidence() throws IOException {
    File dir = pixelDiagnosticDirectory();
    File arm = new File(dir, "arm");
    if (pixelPersistent) {
      log("PIXEL_BURST_START capture=" + pixelCaptureId + " count=" + PIXEL_BURST_PRESENTS + " target=" + PKG +
        " runner=" + ISOLATED_RUNNER + " pid=" + android.os.Process.myPid() + " fixture=credits-amll positionMs=51600");
    }
    if (!bootstrapEmbeddedBundle()) throw new IOException("Isolated embedded AMLL credits bootstrap failed");
    if (!waitForUi(new Condition() {
      @Override public boolean matches() { return pixelControlsClear() && !pixelViewport(null, new Point()).isEmpty(); }
    })) throw new IOException("Isolated Rust viewport did not become unobstructed");
    // The dock hides from accessibility at the start of its 700 ms hold and 400 ms fade.
    sleep(1100);
    AccessibilityNodeInfo window = ui.getRootInActiveWindow();
    if (!playerIdentity(window, "credits")) throw new IOException("Open the isolated paused credits player first");
    String label = "Recreate Rust surface";
    int[] recreate = findVisibleLabel(window, label, true);
    if (recreate == null) recreate = findVisibleLabel(window, label, false);
    if (recreate == null) throw new IOException("Rust surface recreate control is unavailable");
    pixelExportFiles.add(pixelScreenshot("pixel-no-copy-control", null));
    int controlTexture = pixelScreenshotTexture;
    recordPixelDevice();
    log("PIXEL_DIAG_CONTROL pid=" + android.os.Process.myPid());

    File receipt = new File(dir, "frame-1-textureview.json");
    clearPixelReceipts(dir);
    armPixelCapture(arm);
    boolean released = false;
    try {
      if (!tap(recreate[0], recreate[1])) throw new IOException("Could not tap Recreate Rust surface");
      log("PIXEL_DIAG_RECREATE capture=" + pixelCaptureId + " x=" + recreate[0] + " y=" + recreate[1]);
      long deadline = SystemClock.elapsedRealtime() + (pixelPersistent ? 22_000 : 12_000);
      JSONObject captured = null;
      while (SystemClock.elapsedRealtime() < deadline) {
        requireBurstActive(dir);
        if (!arm.exists()) {
          captured = matchingPixelReceipt(receipt);
          if (captured != null) break;
        }
        sleep(40);
      }
      if (captured == null) {
        if (pixelPersistent) log("PIXEL_BURST_WAIT_TIMEOUT capture=" + pixelCaptureId + " phase=" +
          (arm.exists() ? "unclaimed" : "textureReceipt"));
        throw new IOException("No matching TextureView update for capture " + pixelCaptureId);
      }
      if (pixelPersistent) {
        if (!validBurstHistory(captured) || captured.optInt("texture") == controlTexture) {
          throw new IOException("Incomplete burst history or recreated surface identity missing");
        }
        log("PIXEL_BURST_HELD capture=" + pixelCaptureId + " controlTexture=" + controlTexture +
          " texture=" + captured.optInt("texture") + " session=" + captured.optLong("session") +
          " generation=" + captured.optLong("generation") + " bufferNs=" + captured.optLong("bufferNs"));
      }
      log("PIXEL_DIAG_TEXTURE capture=" + pixelCaptureId);
      if (!pixelPersistent) sleep(50);
      if (!playerIdentity(ui.getRootInActiveWindow(), "credits")) {
        throw new IOException("Isolated credits player lost foreground before pixel screenshot");
      }
      File composited = pixelScreenshot("pixel-frame-1-composited", captured);
      requireBurstActive(dir);
      releasePixelHold(dir);
      released = true;
      collectPixelStages(dir, composited);
    } finally {
      if (!released && !Files.deleteIfExists(arm.toPath())) {
        // Rust claimed the arm, so release even if receipt or screenshot collection failed.
        releasePixelHold(dir);
      }
    }
  }

  private void requireBurstActive(File dir) throws IOException {
    if (!pixelPersistent) return;
    Path failure = new File(dir, "burst-failed").toPath();
    if (!Files.exists(failure, LinkOption.NOFOLLOW_LINKS)) return;
    int code = 0;
    if (Files.isRegularFile(failure, LinkOption.NOFOLLOW_LINKS) && Files.size(failure) <= 16) {
      String marker = new String(Files.readAllBytes(failure), StandardCharsets.UTF_8).trim();
      if (marker.matches(pixelCaptureId + " (1[0-2]|2[0-9]|3[0-9]|4[0-5])")) {
        code = Integer.parseInt(marker.substring(marker.indexOf(' ') + 1));
      }
    }
    log("PIXEL_BURST_FAILED capture=" + pixelCaptureId + " code=" + code);
    throw new IOException("Isolated burst aborted before a held crop was verified, code=" + code);
  }

  private String coldSurfaceEvents() throws IOException {
    try {
      String clock = pixelColdFactorial ? " -v threadtime -v monotonic -v usec" : "";
      return shellChecked("timeout 5 logcat -d --pid=" + android.os.Process.myPid() + clock + " -s KSRustDiag:I");
    } catch (IOException unavailable) {
      throw new IOException("Could not read the isolated cold surface markers");
    }
  }

  private void confirmInitialPixelSurface(boolean armed) throws IOException {
    String events = coldSurfaceEvents();
    requireColdFactorStartup(events);
    if (count(events, " surface.available ") != 1 || count(events, " surface.firstUpdate ") != 1) {
      throw new IOException("Cold crop does not have exactly one initial Rust surface and first update");
    }
    if (armed && count(events, "gpu.firstPresent frame=1 capture=Some(" + pixelCaptureId + ")") != 1) {
      throw new IOException("Cold capture was not the first GPU present of the initial surface");
    }
    String identity = " texture=" + pixelScreenshotTexture + " session=([0-9]+) ";
    Matcher available = Pattern.compile("monoNs=([0-9]+) surface\\.available" + identity).matcher(events);
    Matcher updated = Pattern.compile("monoNs=([0-9]+) surface\\.firstUpdate" + identity).matcher(events);
    if (!available.find() || !updated.find() || !available.group(2).equals(updated.group(2))) {
      throw new IOException("Cold crop did not come from the initial Rust surface");
    }
    long availableNs = Long.parseLong(available.group(1));
    long firstUpdateNs = Long.parseLong(updated.group(1));
    if (availableNs < pixelColdSeedNs || firstUpdateNs < availableNs || pixelScreenshotNs < firstUpdateNs) {
      throw new IOException("Cold crop did not follow the seeded initial Rust surface update");
    }
    log("PIXEL_COLD_FRAME texture=" + pixelScreenshotTexture + " session=" + available.group(2) +
      " availableNs=" + availableNs + " firstUpdateNs=" + firstUpdateNs + " sampledNs=" + pixelScreenshotNs +
      " afterFirstUpdateMs=" + (pixelScreenshotNs - firstUpdateNs) / 1_000_000);
    if (pixelColdFactorial) confirmColdFactor(events, available.group(2), availableNs, firstUpdateNs);
  }

  private void requireColdFactorStartup(String events) throws IOException {
    if (!pixelColdFactorial) return;
    if (events.contains("pixelDiag.coldFactor phase=surfaceLost ")) {
      throw new IOException("Cold-factor surface was lost before the first present (surfaceLost)");
    }
    if (!events.contains("pixelDiag.coldFactor phase=ready ")) {
      throw new IOException("Missing cold-factor ready snapshot");
    }
  }

  private long coldLogClock(String events, String marker) throws IOException {
    Matcher match = Pattern.compile("(?m)^[ \\t]*(\\d+)\\.(\\d{6})[ \\t]+[^\\r\\n]*?" +
      Pattern.quote(marker) + "[^\\r\\n]*$").matcher(events);
    if (!match.find()) throw new IOException("Missing monotonic cold-factor log timestamp");
    long time = Long.parseLong(match.group(1)) * 1_000_000_000L + Long.parseLong(match.group(2)) * 1000L;
    if (match.find()) throw new IOException("Duplicate cold-factor log timestamp");
    return time;
  }

  private MatchResult coldFactorSnapshot(String events, String phase, String session) throws IOException {
    String mode = String.valueOf(COLD_FACTOR_ORDER.charAt(pixelColdTrial - 1));
    Matcher match = Pattern.compile("monoNs=(\\d+) (pixelDiag\\.coldFactor phase=" + phase +
      " trial=" + pixelColdTrial + " mode=" + mode + " texture=" + pixelScreenshotTexture + " session=" + session +
      " generation=(\\d+) sequence=(\\d+) followEpoch=(\\d+) revision=(\\d+) priorPresents=(\\d+)" +
      " attempt=(\\d+) requestedRevision=(-?\\d+) workerGeneration=(-?\\d+) status=(-?\\d+))(?=\\r?$)",
      Pattern.MULTILINE).matcher(events);
    if (!match.find()) throw new IOException("Missing cold-factor snapshot: " + phase);
    MatchResult snapshot = match.toMatchResult();
    if (match.find()) throw new IOException("Duplicate cold-factor snapshot: " + phase);
    log("PIXEL_FACTOR_SNAPSHOT monoNs=" + snapshot.group(1) + " " + snapshot.group(2));
    return snapshot;
  }

  private void confirmColdFactor(String events, String session, long availableNs, long firstUpdateNs) throws IOException {
    String firstPresent = "gpu.firstPresent frame=1 capture=None";
    if (count(events, "gpu.firstPresent ") != 1 || count(events, firstPresent) != 1 ||
        events.contains(" surface.resize ") || events.contains(" surface.destroy ") || events.contains("pixelDiag.armed") ||
        events.contains("pixelDiag.burstArmed") || events.contains("pixelDiag.coldFactor phase=timeout")) {
      throw new IOException("Cold-factor initial surface or ordinary GPU usage evidence did not match");
    }
    Matcher config = Pattern.compile("gpu\\.surface\\.configured adapter=[^\\r\\n]*?\\bbackend: (Vulkan|Gl)" +
      "[^\\r\\n]*? size=(\\d+)x(\\d+) format=(Rgba8Unorm|Bgra8Unorm) alpha=(Inherit|PreMultiplied|PostMultiplied) presentMode=Fifo")
      .matcher(events);
    if (!config.find() || Integer.parseInt(config.group(2)) != pixelScreenshotWidth ||
        Integer.parseInt(config.group(3)) != pixelScreenshotHeight) throw new IOException("Cold-factor GPU configuration missing or changed");
    log("PIXEL_FACTOR_CONFIG backend=" + config.group(1) + " width=" + config.group(2) + " height=" + config.group(3) +
      " format=" + config.group(4) + " alpha=" + config.group(5) + " presentMode=Fifo");
    if (config.find()) throw new IOException("Duplicate cold-factor GPU configuration");
    MatchResult ticket = coldFactorSnapshot(events, "ticket", session);
    MatchResult ready = coldFactorSnapshot(events, "ready", session);
    MatchResult submit = coldFactorSnapshot(events, "submit", session);
    MatchResult result = coldFactorSnapshot(events, "result", session);
    MatchResult present = coldFactorSnapshot(events, "present", session);
    if (!present.group(8).equals("1") || !present.group(9).equals(submit.group(6))) {
      throw new IOException("Cold-factor present did not come from the first submission and its revision");
    }
    long submitNs = Long.parseLong(submit.group(1)), presentDoneNs = Long.parseLong(present.group(1));
    long availableOffset = availableNs - coldLogClock(events, "monoNs=" + availableNs + " surface.available");
    long updateOffset = firstUpdateNs - coldLogClock(events, "monoNs=" + firstUpdateNs + " surface.firstUpdate");
    long presentNs = coldLogClock(events, firstPresent) + updateOffset;
    final long clockToleranceNs = 10_000_000L;
    if (Math.abs(availableOffset - updateOffset) > clockToleranceNs || presentNs < submitNs - clockToleranceNs ||
        presentNs > presentDoneNs + clockToleranceNs || presentNs > pixelScreenshotNs || presentDoneNs > pixelScreenshotNs ||
        Long.parseLong(ticket.group(1)) < pixelColdSeedNs || Long.parseLong(ticket.group(1)) > submitNs ||
        Long.parseLong(ready.group(1)) > pixelScreenshotNs || Long.parseLong(result.group(1)) < submitNs ||
        !ticket.group(7).equals("0") || !submit.group(7).equals("0") || !result.group(7).equals("0") ||
        !present.group(7).equals("0") || !submit.group(8).equals("1") || !result.group(8).equals("1") ||
        !submit.group(6).equals(submit.group(9)) || !submit.group(9).equals(result.group(9)) ||
        !present.group(11).equals("0")) {
      throw new IOException("Cold-factor timing or initial submission evidence is inconsistent");
    }
    if (COLD_FACTOR_ORDER.charAt(pixelColdTrial - 1) == 'G' &&
        (Long.parseLong(ready.group(1)) >= submitNs || !ready.group(3).equals(submit.group(3)) ||
         Long.parseLong(submit.group(4)) <= Long.parseLong(ready.group(4)) ||
         Long.parseLong(submit.group(5)) <= Long.parseLong(ready.group(5)) ||
         !present.group(3).equals(present.group(10)) || !present.group(6).equals(present.group(9)))) {
      throw new IOException("G did not present a current first frame after the readiness fence");
    }
    log("PIXEL_FACTOR_TIMING firstPresentNs=" + presentNs + " firstUpdateNs=" + firstUpdateNs +
      " sampledNs=" + pixelScreenshotNs + " afterFirstPresentNs=" + (pixelScreenshotNs - presentNs) +
      " afterFirstUpdateNs=" + (pixelScreenshotNs - firstUpdateNs) + " clockOffsetDriftNs=" + (availableOffset - updateOffset));
  }

  private void requireColdFirstActive(File dir) throws IOException {
    Path failure = new File(dir, "cold-first-failed").toPath();
    if (!Files.exists(failure, LinkOption.NOFOLLOW_LINKS)) return;
    int code = 0;
    if (Files.isRegularFile(failure, LinkOption.NOFOLLOW_LINKS) && Files.size(failure) <= 16) {
      String marker = new String(Files.readAllBytes(failure), StandardCharsets.UTF_8).trim();
      if (marker.matches(pixelCaptureId + " [1-7]")) code = marker.charAt(marker.length() - 1) - '0';
    }
    log("PIXEL_COLD_FIRST_REJECTED capture=" + pixelCaptureId + " code=" + code);
    throw new IOException("Initial Rust frame was rejected, code=" + code);
  }

  private void pixelColdEvidence(String output) throws IOException {
    boolean armed = !pixelColdFactorial && pixelColdTrial % 2 == 0;
    log("PIXEL_COLD_TRIAL ordinal=" + pixelColdTrial + " total=" + PIXEL_COLD_TRIALS +
      " mode=" + (armed ? "armed" : "no-copy") + " capture=" + (armed ? pixelCaptureId : 0) +
      " app=" + PKG + " runner=" + ISOLATED_RUNNER + " pid=" + android.os.Process.myPid() + " output=" + output);
    log("PIXEL_COLD_FIXTURE fx=credits-amll style=amll track=fx-track-credits playing=false posMs=51600");
    File dir = pixelDiagnosticDirectory();
    File arm = new File(dir, "arm");
    if (!bootstrapEmbeddedBundle()) throw new IOException("Isolated embedded cold bootstrap failed");
    String preSeedEvents = coldSurfaceEvents();
    if (preSeedEvents.contains(" surface.available ") || preSeedEvents.contains("gpu.firstPresent")) {
      throw new IOException("Rust surface already created before the cold fixture seed");
    }
    clearPixelReceipts(dir);
    Path coldFirst = new File(dir, "cold-first").toPath();
    File factorTicket = new File(dir, "cold-factor");
    boolean published = false;
    boolean released = false;
    try {
      if (pixelColdFactorial) {
        char mode = COLD_FACTOR_ORDER.charAt(pixelColdTrial - 1);
        publishPixelMarker(factorTicket, pixelColdTrial + " " + mode);
        log("PIXEL_FACTOR_PLAN trial=" + pixelColdTrial + " mode=" + mode + " order=" + COLD_FACTOR_ORDER +
          " publishedNs=" + System.nanoTime());
      }
      if (armed) {
        // The side marker is complete before the atomic decimal arm becomes visible to Kotlin or Rust.
        Files.write(coldFirst, Integer.toString(pixelCaptureId).getBytes(StandardCharsets.UTF_8));
        armPixelCapture(arm);
        published = true;
      }
      if (!initialPixelFixture()) throw new IOException("Isolated cold credits fixture ACK missing");
      File receipt = new File(dir, "frame-1-textureview.json");
      JSONObject captured = null;
      long clearSince = -1;
      long deadline = SystemClock.elapsedRealtime() + 12_000;
      File cropped = null;
      while (SystemClock.elapsedRealtime() < deadline) {
        if (armed) {
          requireColdFirstActive(dir);
          if (captured == null && !arm.exists()) {
            captured = matchingPixelReceipt(receipt);
            if (captured != null && !validColdFirstReceipt(captured)) throw new IOException("Invalid first-surface receipt");
          }
        }
        long now = SystemClock.elapsedRealtime();
        if (!pixelControlsClear()) {
          clearSince = -1;
        } else if (clearSince < 0) {
          clearSince = now;
        } else if (now - clearSince >= 1100 && (!armed || captured != null) &&
                   !pixelViewport(captured, new Point()).isEmpty()) {
          cropped = pixelScreenshot(armed ? "pixel-frame-1-composited" : "pixel-no-copy-control", captured);
          break;
        }
        // Observe the clear UI throughout the dock's bounded 700 ms hold and 400 ms fade.
        sleep(40);
      }
      if (cropped == null) {
        log("PIXEL_COLD_WAIT_TIMEOUT capture=" + (armed ? pixelCaptureId : 0) + " receipt=" + (captured != null));
        if (pixelColdFactorial) requireColdFactorStartup(coldSurfaceEvents());
        throw new IOException("No eligible initial Rust viewport within the cold sampling window");
      }
      if (armed) {
        requireColdFirstActive(dir);
        releasePixelHold(dir);
        released = true;
      } else if (Files.exists(arm.toPath(), LinkOption.NOFOLLOW_LINKS) ||
                 Files.exists(new File(dir, "frame-1.ready").toPath(), LinkOption.NOFOLLOW_LINKS)) {
        throw new IOException("A diagnostic marker appeared during the cold no-copy trial");
      }
      confirmInitialPixelSurface(armed);
      // Hash the two installed APKs after sampling so evidence identification cannot delay the frame.
      log("PIXEL_COLD_ARTIFACT appBaseSha256=" + pixelHash(new File(getTargetContext().getApplicationInfo().sourceDir)) +
        " runnerBaseSha256=" + pixelHash(new File(getContext().getApplicationInfo().sourceDir)));
      recordPixelDevice();
      if (armed) collectPixelStages(dir, cropped);
      else pixelExportFiles.add(cropped);
      log("PIXEL_COLD_RESULT captured=true");
    } finally {
      try {
        if (published && !released && !Files.deleteIfExists(arm.toPath())) releasePixelHold(dir);
      } finally {
        if (armed) Files.deleteIfExists(coldFirst);
        if (pixelColdFactorial) Files.deleteIfExists(factorTicket.toPath());
      }
    }
  }

  @Override public void onStart() {
    status(1, null);
    long started = SystemClock.elapsedRealtime();
    String run = "run-" + System.currentTimeMillis() + "-" + UUID.randomUUID().toString().substring(0, 8);
    String output = EXPORT_ROOT + "/" + run;
    boolean exported = false;
    Throwable error = null;
    if (remainingGates) scenarioDeadline = started + 12 * 60 * 1000L;
    if (pixelColdRepro) scenarioDeadline = started + 150_000;
    try {
      if (pixelDiagOnly && (!ISOLATED_PACKAGE.equals(PKG) ||
          !ISOLATED_PACKAGE.equals(getTargetContext().getPackageName()))) {
        throw new IOException("pixelDiagOnly requires the isolated BlueStacks runner and target");
      }
      if (pixelColdRepro && (pixelColdTrial == 0 || remainingGates ||
          !ISOLATED_RUNNER.equals(getContext().getPackageName()))) {
        throw new IOException("pixelColdRepro requires the isolated runner, pixelColdTrial 1 through 6 and no remainingGates");
      }
      if (pixelPersistent && (pixelColdRepro || remainingGates || pixelBurstId < 177 || pixelBurstId > 255 ||
          !ISOLATED_RUNNER.equals(getContext().getPackageName()))) {
        throw new IOException("pixelPersistent requires the isolated runner and unused pixelBurstId 177 through 255");
      }
      File ext = getTargetContext().getExternalFilesDir(null);
      root = new File(new File(ext != null ? ext : getTargetContext().getFilesDir(), "fullapp"), run);
      if (!root.mkdirs()) throw new IOException("Cannot create evidence directory " + root);
      proto = new PrintWriter(new FileWriter(new File(root, "protocol.log")));
      summary.append("remainingGates=").append(remainingGates).append("\nexportDirectory=").append(output).append('\n');
      if (pixelDiagOnly) summary.append("pixelDiagOnly=true\n");
      ui = getUiAutomation();
      AccessibilityServiceInfo si = ui.getServiceInfo();
      si.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
      ui.setServiceInfo(si);
      if (pixelColdRepro) {
        pixelColdEvidence(output);
      } else if (pixelDiagOnly) {
        pixelDiagnosticEvidence();
      } else {
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
      }
    } catch (Throwable t) {
      error = t;
      if (pixelColdRepro && proto != null) log("PIXEL_COLD_RESULT captured=false");
    } finally {
      scenarioDeadline = Long.MAX_VALUE;
      if (!pixelDiagOnly && ui != null && proto != null) {
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
        if (pixelDiagOnly) {
          pixelExportFiles.add(new File(root, "protocol.log"));
        } else {
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
