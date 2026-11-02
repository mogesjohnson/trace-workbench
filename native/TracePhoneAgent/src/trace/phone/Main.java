package trace.phone;

import android.graphics.Bitmap;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.zip.CRC32;
import org.json.JSONObject;

/**
 * TRACE phone agent. Runs on the device as the shell user through app_process
 * and serves one abstract local socket. Each request is a length-prefixed JSON
 * object; each reply is a length-prefixed JSON header followed by a
 * length-prefixed binary payload (empty when there is no image or text body).
 * Frames are captured, hashed, cropped, scaled and encoded on the device so a
 * Wi-Fi link carries kilobytes instead of a 4-bytes-per-pixel raw frame.
 */
public final class Main {
  static final String VERSION = "1";
  static final Object CAPTURE_LOCK = new Object();
  static Method injectMethod;
  static Object inputManager;

  static final int SHELL_UID = 2000;

  /**
   * Abstract sockets are reachable by every app on the device, and this process
   * holds shell rights (input injection, screen capture). Only adbd (shell uid,
   * which carries both USB and Wi-Fi adb forwards) and root may connect, plus
   * one uid the owner names explicitly (e.g. Termux for an on-phone agent).
   * There is deliberately no command-execution operation.
   */
  public static void main(String[] args) throws Exception {
    String name = args.length > 0 ? args[0] : "trace-phone";
    final int extraUid = args.length > 1 ? Integer.parseInt(args[1]) : -1;
    LocalServerSocket server = new LocalServerSocket(name);
    System.out.println("trace-phone agent " + VERSION + " listening on @" + name
        + (extraUid >= 0 ? " (also uid " + extraUid + ")" : ""));
    System.out.flush();
    while (true) {
      final LocalSocket socket = server.accept();
      int uid;
      try { uid = socket.getPeerCredentials().getUid(); } catch (Throwable error) { uid = -1; }
      if (uid != SHELL_UID && uid != 0 && (extraUid < 0 || uid != extraUid)) {
        try { socket.close(); } catch (Throwable ignored) { }
        continue;
      }
      Thread worker = new Thread(() -> serve(socket));
      worker.setDaemon(true);
      worker.start();
    }
  }

  static void serve(LocalSocket socket) {
    try (LocalSocket s = socket) {
      DataInputStream in = new DataInputStream(s.getInputStream());
      DataOutputStream out = new DataOutputStream(s.getOutputStream());
      while (true) {
        int length;
        try { length = in.readInt(); } catch (java.io.EOFException end) { return; }
        if (length <= 0 || length > (1 << 20)) return;
        byte[] body = new byte[length];
        in.readFully(body);
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        JSONObject header = new JSONObject();
        byte[] payload = new byte[0];
        long started = SystemClock.elapsedRealtimeNanos();
        try {
          payload = handle(request, header);
          header.put("ok", true);
        } catch (Throwable error) {
          header.put("ok", false);
          header.put("error", String.valueOf(error));
        }
        header.put("agentMs", (SystemClock.elapsedRealtimeNanos() - started) / 1e6);
        if (request.has("id")) header.put("id", request.get("id"));
        byte[] encoded = header.toString().getBytes(StandardCharsets.UTF_8);
        out.writeInt(encoded.length);
        out.write(encoded);
        out.writeInt(payload.length);
        out.write(payload);
        out.flush();
      }
    } catch (Throwable ignored) {
      // The host reconnects on a broken socket; nothing to recover here.
    }
  }

  static byte[] handle(JSONObject r, JSONObject h) throws Exception {
    String op = r.getString("op");
    switch (op) {
      case "hello":
        h.put("version", VERSION);
        h.put("sdk", android.os.Build.VERSION.SDK_INT);
        h.put("model", android.os.Build.MODEL);
        h.put("statusBar", statusBarHeight());
        h.put("inject", injector() != null);
        // Closing the adb exec stream does not stop this process; the host kills it by pid.
        h.put("pid", android.os.Process.myPid());
        return new byte[0];
      case "screen":
        return screen(r, h);
      case "wait":
        return waitFor(r, h);
      case "tap":
        tap(r.getInt("x"), r.getInt("y"), r.optLong("holdMs", 40));
        return new byte[0];
      case "swipe":
        swipe(r.getInt("x1"), r.getInt("y1"), r.getInt("x2"), r.getInt("y2"), r.optLong("durationMs", 250));
        return new byte[0];
      case "key":
        key(r.getInt("code"), r.optInt("meta", 0));
        return new byte[0];
      case "text":
        h.put("method", text(r.getString("text")));
        return new byte[0];
      case "ui":
        return Ui.tree(r, h);
      case "find":
        return Ui.find(r, h);
      case "node":
        return Ui.act(r, h);
      case "release":
        // Android allows one UiAutomation connection at a time; while this agent
        // holds it, `uiautomator dump` fails. release frees it; the next ui/find/node
        // reconnects.
        h.put("released", Ui.release());
        return new byte[0];
      default:
        throw new IllegalArgumentException("unknown op " + op);
    }
  }

  // ---------- capture ----------

  static final class Frame {
    byte[] raw; int offset; int width; int height; long crc;
  }

  static Frame capture(int ignoreTop) throws Exception {
    synchronized (CAPTURE_LOCK) {
      Process process = Runtime.getRuntime().exec(new String[] {"screencap"});
      byte[] raw = readAll(process.getInputStream(), 20 << 20);
      process.waitFor();
      ByteBuffer header = ByteBuffer.wrap(raw, 0, 16).order(java.nio.ByteOrder.LITTLE_ENDIAN);
      Frame f = new Frame();
      f.width = header.getInt();
      f.height = header.getInt();
      int format = header.getInt();
      if (format != 1) throw new IllegalStateException("unsupported pixel format " + format);
      f.offset = raw.length - f.width * f.height * 4;
      if (f.offset != 12 && f.offset != 16) throw new IllegalStateException("unexpected screencap size");
      f.raw = raw;
      int skip = Math.max(0, Math.min(ignoreTop, f.height)) * f.width * 4;
      CRC32 crc = new CRC32();
      crc.update(raw, f.offset + skip, raw.length - f.offset - skip);
      f.crc = crc.getValue();
      return f;
    }
  }

  static byte[] screen(JSONObject r, JSONObject h) throws Exception {
    int ignoreTop = r.optInt("ignoreTop", statusBarHeight());
    long t0 = SystemClock.elapsedRealtimeNanos();
    Frame f = capture(ignoreTop);
    long t1 = SystemClock.elapsedRealtimeNanos();
    String hash = Long.toHexString(f.crc);
    h.put("hash", hash);
    h.put("width", f.width);
    h.put("height", f.height);
    h.put("captureMs", (t1 - t0) / 1e6);
    if (hash.equals(r.optString("ifChangedFrom", ""))) {
      h.put("changed", false);
      return new byte[0];
    }
    h.put("changed", true);
    return encode(f, r, h);
  }

  static byte[] encode(Frame f, JSONObject r, JSONObject h) throws Exception {
    long t0 = SystemClock.elapsedRealtimeNanos();
    Bitmap full = Bitmap.createBitmap(f.width, f.height, Bitmap.Config.ARGB_8888);
    full.copyPixelsFromBuffer(ByteBuffer.wrap(f.raw, f.offset, f.width * f.height * 4));
    Bitmap region = full;
    int rx = 0, ry = 0, rw = f.width, rh = f.height;
    JSONObject crop = r.optJSONObject("region");
    if (crop != null) {
      rx = clamp(crop.getInt("x"), 0, f.width - 1);
      ry = clamp(crop.getInt("y"), 0, f.height - 1);
      rw = clamp(crop.getInt("width"), 1, f.width - rx);
      rh = clamp(crop.getInt("height"), 1, f.height - ry);
      region = Bitmap.createBitmap(full, rx, ry, rw, rh);
    }
    int maxSide = r.optInt("maxSide", 1280);
    double scale = Math.min(1.0, maxSide / (double) Math.max(rw, rh));
    int ow = Math.max(1, (int) Math.round(rw * scale));
    int oh = Math.max(1, (int) Math.round(rh * scale));
    Bitmap scaled = scale < 1.0 ? Bitmap.createScaledBitmap(region, ow, oh, true) : region;
    String format = r.optString("format", "jpeg");
    Bitmap.CompressFormat cf = "png".equals(format) ? Bitmap.CompressFormat.PNG
        : "webp".equals(format) ? Bitmap.CompressFormat.WEBP_LOSSY : Bitmap.CompressFormat.JPEG;
    ByteArrayOutputStream bytes = new ByteArrayOutputStream(256 << 10);
    scaled.compress(cf, r.optInt("quality", 75), bytes);
    if (scaled != region) scaled.recycle();
    if (region != full) region.recycle();
    full.recycle();
    h.put("format", format);
    h.put("imageWidth", ow);
    h.put("imageHeight", oh);
    h.put("regionX", rx);
    h.put("regionY", ry);
    h.put("regionWidth", rw);
    h.put("regionHeight", rh);
    h.put("scale", (double) ow / rw);
    h.put("encodeMs", (SystemClock.elapsedRealtimeNanos() - t0) / 1e6);
    return bytes.toByteArray();
  }

  /** Poll on the device so waiting costs no link traffic. */
  static byte[] waitFor(JSONObject r, JSONObject h) throws Exception {
    String mode = r.optString("until", "stable");
    long timeout = r.optLong("timeoutMs", 5000);
    long stableFor = r.optLong("stableMs", 300);
    int ignoreTop = r.optInt("ignoreTop", statusBarHeight());
    if (!"change".equals(mode) && !"stable".equals(mode)) throw new IllegalArgumentException("unknown until " + mode);
    String from = r.optString("from", "");
    long deadline = SystemClock.uptimeMillis() + timeout;
    Frame f = capture(ignoreTop);
    int frames = 1;
    long since = SystemClock.uptimeMillis();
    boolean met = false;
    // Without "from", the first frame captured here is the baseline, so
    // until:"change" waits for the screen to differ from how it is now.
    String baseline = from.isEmpty() ? Long.toHexString(f.crc) : from;
    boolean changed = !Long.toHexString(f.crc).equals(baseline);
    while (true) {
      if ("change".equals(mode) && changed) { met = true; break; }
      if ("stable".equals(mode) && SystemClock.uptimeMillis() - since >= stableFor
          && (from.isEmpty() || changed || r.optBoolean("allowUnchanged", true))) { met = true; break; }
      if (SystemClock.uptimeMillis() >= deadline) break;
      Frame next = capture(ignoreTop);
      frames++;
      if (next.crc != f.crc) since = SystemClock.uptimeMillis();
      if (!Long.toHexString(next.crc).equals(baseline)) changed = true;
      f = next;
    }
    h.put("met", met);
    h.put("frames", frames);
    h.put("hash", Long.toHexString(f.crc));
    h.put("changed", changed);
    h.put("width", f.width);
    h.put("height", f.height);
    if (r.optBoolean("image", false)) return encode(f, r, h);
    return new byte[0];
  }

  // ---------- input ----------

  static Method injector() {
    if (injectMethod != null) return injectMethod;
    String[] owners = {"android.hardware.input.InputManagerGlobal", "android.hardware.input.InputManager"};
    for (String owner : owners) {
      try {
        Class<?> type = Class.forName(owner);
        Object instance = type.getDeclaredMethod("getInstance").invoke(null);
        Method method = type.getMethod("injectInputEvent", InputEvent.class, int.class);
        inputManager = instance;
        injectMethod = method;
        return method;
      } catch (Throwable ignored) {
        // try the next owner
      }
    }
    return null;
  }

  static void inject(InputEvent event) throws Exception {
    Method method = injector();
    if (method == null) throw new IllegalStateException("input injection unavailable");
    // 2 = INJECT_INPUT_EVENT_MODE_WAIT_FOR_FINISH
    Object ok = method.invoke(inputManager, event, 2);
    if (Boolean.FALSE.equals(ok)) throw new IllegalStateException("input injection refused");
  }

  static MotionEvent motion(long down, long when, int action, float x, float y) {
    MotionEvent event = MotionEvent.obtain(down, when, action, x, y, 0);
    event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    return event;
  }

  static void tap(int x, int y, long holdMs) throws Exception {
    long down = SystemClock.uptimeMillis();
    inject(motion(down, down, MotionEvent.ACTION_DOWN, x, y));
    if (holdMs > 0) SystemClock.sleep(holdMs);
    inject(motion(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y));
  }

  static void swipe(int x1, int y1, int x2, int y2, long durationMs) throws Exception {
    long down = SystemClock.uptimeMillis();
    inject(motion(down, down, MotionEvent.ACTION_DOWN, x1, y1));
    int steps = (int) Math.max(2, durationMs / 8);
    for (int i = 1; i <= steps; i++) {
      float t = i / (float) steps;
      SystemClock.sleep(Math.max(1, durationMs / steps));
      inject(motion(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t));
    }
    inject(motion(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x2, y2));
  }

  static void key(int code, int meta) throws Exception {
    long now = SystemClock.uptimeMillis();
    inject(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
    inject(new KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
  }

  static String text(String value) throws Exception {
    KeyEvent[] events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(value.toCharArray());
    if (events != null) {
      for (KeyEvent event : events) {
        inject(KeyEvent.changeTimeRepeat(event, SystemClock.uptimeMillis(), 0));
      }
      return "keys";
    }
    // Characters without a key mapping (emoji, most non-Latin text): append to
    // the focused editable field through accessibility instead.
    android.view.accessibility.AccessibilityNodeInfo focused =
        Ui.automation().findFocus(android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT);
    if (focused == null || !focused.isEditable()) throw new IllegalStateException("no focused text field for non-keyboard text");
    CharSequence current = focused.getText();
    android.os.Bundle args = new android.os.Bundle();
    args.putCharSequence(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
        (current == null || focused.isShowingHintText() ? "" : current.toString()) + value);
    if (!focused.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
      throw new IllegalStateException("the focused field refused text");
    }
    return "set_text";
  }

  // ---------- helpers ----------

  static int statusBarHeight() {
    try {
      android.content.res.Resources res = android.content.res.Resources.getSystem();
      int id = res.getIdentifier("status_bar_height", "dimen", "android");
      return id > 0 ? res.getDimensionPixelSize(id) : 0;
    } catch (Throwable ignored) {
      return 0;
    }
  }

  static int clamp(int value, int lo, int hi) { return Math.max(lo, Math.min(hi, value)); }

  static byte[] readAll(InputStream in, int expected) throws Exception {
    ByteArrayOutputStream out = new ByteArrayOutputStream(Math.min(expected, 20 << 20));
    byte[] buffer = new byte[1 << 16];
    int n;
    while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
    return out.toByteArray();
  }
}
