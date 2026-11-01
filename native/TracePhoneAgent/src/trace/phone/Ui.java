package trace.phone;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.lang.reflect.Constructor;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * One persistent UiAutomation connection. uiautomator dump pays process start
 * and connection setup on every call; holding the connection makes a tree read
 * cost only the accessibility traversal.
 */
final class Ui {
  private static UiAutomation automation;
  private static HandlerThread thread;
  static String constructor;

  static synchronized UiAutomation automation() throws Exception {
    if (automation != null) return automation;
    thread = new HandlerThread("trace-ui");
    thread.start();
    Class<?> connectionType = Class.forName("android.app.UiAutomationConnection");
    Object connection = connectionType.getDeclaredConstructor().newInstance();
    Class<?> iface = Class.forName("android.app.IUiAutomationConnection");
    final Looper looper = thread.getLooper();
    UiAutomation created = null;
    String used = null;
    // Constructor shapes differ by release. None of them needs a real app
    // context, so ActivityThread.systemMain() (which boots system-server state
    // inside this process) is never called.
    for (Constructor<?> c : UiAutomation.class.getDeclaredConstructors()) {
      Class<?>[] p = c.getParameterTypes();
      Object[] args = null;
      if (p.length == 2 && p[0] == Looper.class && p[1] == iface) {
        args = new Object[] {looper, connection};
      } else if (p.length == 3 && p[0] == int.class && p[1] == Looper.class && p[2] == iface) {
        args = new Object[] {0, looper, connection};
      }
      if (args == null) continue;
      c.setAccessible(true);
      created = (UiAutomation) c.newInstance(args);
      used = java.util.Arrays.toString(p);
      break;
    }
    if (created == null) {
      for (Constructor<?> c : UiAutomation.class.getDeclaredConstructors()) {
        Class<?>[] p = c.getParameterTypes();
        if (p.length == 2 && p[0] == android.content.Context.class && p[1] == iface) {
          c.setAccessible(true);
          created = (UiAutomation) c.newInstance(new LooperContext(looper), connection);
          used = java.util.Arrays.toString(p);
          break;
        }
      }
    }
    if (created == null) throw new IllegalStateException("no usable UiAutomation constructor");
    constructor = used;
    // FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES keeps the owner's own services running.
    UiAutomation.class.getMethod("connect", int.class).invoke(created, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    android.accessibilityservice.AccessibilityServiceInfo info = created.getServiceInfo();
    if (info != null) {
      info.flags |= android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
          | android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
          | android.accessibilityservice.AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
      created.setServiceInfo(info);
      // The flags apply asynchronously: the first read after connect saw 36 of
      // 69 nodes on the S23. Warm up until two traversals visit the same number
      // of nodes (once per connection).
      long deadline = android.os.SystemClock.uptimeMillis() + 1500;
      int previous = -1;
      while (android.os.SystemClock.uptimeMillis() < deadline) {
        int visited = 0;
        for (AccessibilityNodeInfo root : roots(created)) visited += count(root, 0);
        if (visited > 0 && visited == previous) break;
        previous = visited;
        android.os.SystemClock.sleep(50);
      }
    }
    automation = created;
    return created;
  }

  /** UiAutomation(Context, ...) reads only the main looper and display id. */
  static final class LooperContext extends android.content.ContextWrapper {
    private final Looper looper;
    LooperContext(Looper looper) { super(null); this.looper = looper; }
    @Override public Looper getMainLooper() { return looper; }
    // Hidden in the SDK stubs, so no @Override; it still overrides at runtime.
    public int getDisplayId() { return 0; }
  }

  /** Drop the connection so other UiAutomation clients (uiautomator dump) work again. */
  static synchronized boolean release() {
    if (automation == null) return false;
    try { UiAutomation.class.getMethod("disconnect").invoke(automation); } catch (Throwable ignored) { }
    automation = null;
    if (thread != null) { thread.quitSafely(); thread = null; }
    return true;
  }

  static List<AccessibilityNodeInfo> roots(UiAutomation ui) {
    List<AccessibilityNodeInfo> result = new ArrayList<>();
    try {
      List<AccessibilityWindowInfo> windows = ui.getWindows();
      for (AccessibilityWindowInfo window : windows) {
        AccessibilityNodeInfo root = window.getRoot();
        if (root != null) result.add(root);
      }
    } catch (Throwable ignored) {
      // fall through to the active window
    }
    if (result.isEmpty()) {
      AccessibilityNodeInfo root = ui.getRootInActiveWindow();
      if (root != null) result.add(root);
    }
    return result;
  }

  static byte[] tree(JSONObject r, JSONObject h) throws Exception {
    UiAutomation ui = automation();
    boolean all = r.optBoolean("all", false);
    JSONArray nodes = new JSONArray();
    int[] counter = {0};
    for (AccessibilityNodeInfo root : roots(ui)) {
      walk(root, 0, all, nodes, counter, r.optInt("maxNodes", 400));
    }
    h.put("count", nodes.length());
    h.put("visited", counter[0]);
    h.put("package", activePackage(ui));
    h.put("constructor", constructor);
    return nodes.toString().getBytes(StandardCharsets.UTF_8);
  }

  static String activePackage(UiAutomation ui) {
    AccessibilityNodeInfo root = ui.getRootInActiveWindow();
    return root == null || root.getPackageName() == null ? "" : root.getPackageName().toString();
  }

  static void walk(AccessibilityNodeInfo node, int depth, boolean all, JSONArray out, int[] counter, int max) throws Exception {
    if (node == null || out.length() >= max || depth > 64) return;
    counter[0]++;
    if (!node.isVisibleToUser() && !all) return;
    if (all || interesting(node)) out.put(describe(node, depth));
    for (int i = 0; i < node.getChildCount(); i++) walk(node.getChild(i), depth + 1, all, out, counter, max);
  }

  static int count(AccessibilityNodeInfo node, int depth) {
    if (node == null || depth > 64) return 0;
    int total = 1;
    for (int i = 0; i < node.getChildCount(); i++) total += count(node.getChild(i), depth + 1);
    return total;
  }

  static boolean interesting(AccessibilityNodeInfo n) {
    return n.isClickable() || n.isLongClickable() || n.isEditable() || n.isScrollable() || n.isCheckable()
        || nonEmpty(n.getText()) || nonEmpty(n.getContentDescription());
  }

  static boolean nonEmpty(CharSequence s) { return s != null && s.toString().trim().length() > 0; }

  static JSONObject describe(AccessibilityNodeInfo n, int depth) throws Exception {
    Rect b = new Rect();
    n.getBoundsInScreen(b);
    JSONObject o = new JSONObject();
    if (nonEmpty(n.getText())) o.put("text", n.getText().toString());
    if (nonEmpty(n.getContentDescription())) o.put("desc", n.getContentDescription().toString());
    if (n.getViewIdResourceName() != null) o.put("id", n.getViewIdResourceName());
    CharSequence cls = n.getClassName();
    if (cls != null) {
      String name = cls.toString();
      o.put("class", name.substring(name.lastIndexOf('.') + 1));
    }
    o.put("bounds", new JSONArray().put(b.left).put(b.top).put(b.right).put(b.bottom));
    o.put("center", new JSONArray().put(b.centerX()).put(b.centerY()));
    StringBuilder flags = new StringBuilder();
    if (n.isClickable()) flags.append('c');
    if (n.isLongClickable()) flags.append('l');
    if (n.isEditable()) flags.append('e');
    if (n.isScrollable()) flags.append('s');
    if (n.isCheckable()) flags.append(n.isChecked() ? 'X' : 'x');
    if (n.isFocused()) flags.append('f');
    if (n.isSelected()) flags.append('S');
    if (!n.isEnabled()) flags.append('d');
    if (flags.length() > 0) o.put("flags", flags.toString());
    o.put("depth", depth);
    return o;
  }

  /** Match by text, desc, id or class; substring unless exact is set. */
  static List<AccessibilityNodeInfo> match(JSONObject r) throws Exception {
    UiAutomation ui = automation();
    List<AccessibilityNodeInfo> found = new ArrayList<>();
    for (AccessibilityNodeInfo root : roots(ui)) collect(root, r, found, 0);
    return found;
  }

  static void collect(AccessibilityNodeInfo n, JSONObject r, List<AccessibilityNodeInfo> out, int depth) {
    if (n == null || depth > 64 || out.size() >= 50) return;
    if (n.isVisibleToUser() && matches(n, r)) out.add(n);
    for (int i = 0; i < n.getChildCount(); i++) collect(n.getChild(i), r, out, depth + 1);
  }

  static boolean matches(AccessibilityNodeInfo n, JSONObject r) {
    boolean exact = r.optBoolean("exact", false);
    return field(n.getText(), r.optString("text", null), exact)
        && field(n.getContentDescription(), r.optString("desc", null), exact)
        && field(n.getViewIdResourceName(), r.optString("resourceId", null), exact)
        && field(n.getClassName(), r.optString("className", null), false)
        && (!r.has("clickable") || n.isClickable() == r.optBoolean("clickable"))
        && (r.has("text") || r.has("desc") || r.has("resourceId") || r.has("className"));
  }

  static boolean field(CharSequence actual, String wanted, boolean exact) {
    if (wanted == null) return true;
    if (actual == null) return false;
    String a = actual.toString();
    return exact ? a.equals(wanted) : a.toLowerCase().contains(wanted.toLowerCase());
  }

  static byte[] find(JSONObject r, JSONObject h) throws Exception {
    JSONArray nodes = new JSONArray();
    for (AccessibilityNodeInfo n : match(r)) nodes.put(describe(n, 0));
    h.put("count", nodes.length());
    return nodes.toString().getBytes(StandardCharsets.UTF_8);
  }

  /** Act on the n-th matching node: click, long_click, set_text, focus, scroll_forward/backward. */
  static byte[] act(JSONObject r, JSONObject h) throws Exception {
    List<AccessibilityNodeInfo> found = match(r);
    int index = r.optInt("index", 0);
    h.put("matches", found.size());
    if (index >= found.size()) throw new IllegalStateException("no node matches the selector (found " + found.size() + ")");
    AccessibilityNodeInfo node = found.get(index);
    String action = r.optString("action", "click");
    h.put("node", describe(node, 0));
    AccessibilityNodeInfo target = node;
    if ("click".equals(action) || "long_click".equals(action)) {
      // Text is often in a non-clickable child of the clickable row.
      while (target != null && !("click".equals(action) ? target.isClickable() : target.isLongClickable())) target = target.getParent();
      if (target == null) {
        Rect b = new Rect();
        node.getBoundsInScreen(b);
        Main.tap(b.centerX(), b.centerY(), "click".equals(action) ? 40 : 700);
        h.put("method", "tap-center");
        return new byte[0];
      }
    }
    boolean ok;
    switch (action) {
      case "click": ok = target.performAction(AccessibilityNodeInfo.ACTION_CLICK); break;
      case "long_click": ok = target.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK); break;
      case "focus": ok = target.performAction(AccessibilityNodeInfo.ACTION_FOCUS); break;
      case "scroll_forward": ok = scrollable(target).performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD); break;
      case "scroll_backward": ok = scrollable(target).performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD); break;
      case "set_text": {
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, r.optString("value", ""));
        ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        break;
      }
      default: throw new IllegalArgumentException("unknown node action " + action);
    }
    if (!ok) throw new IllegalStateException("the app refused " + action);
    h.put("method", "accessibility");
    if (target != node) h.put("actedOn", describe(target, 0));
    return new byte[0];
  }

  static AccessibilityNodeInfo scrollable(AccessibilityNodeInfo n) {
    AccessibilityNodeInfo t = n;
    while (t != null && !t.isScrollable()) t = t.getParent();
    if (t == null) throw new IllegalStateException("no scrollable ancestor");
    return t;
  }
}
