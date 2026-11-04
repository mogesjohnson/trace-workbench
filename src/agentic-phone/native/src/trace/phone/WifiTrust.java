package trace.phone;

import android.os.IBinder;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Wi-Fi trust watcher. Runs on the device as the shell user through app_process
 * (started by scripts/phone-boot-adb.cjs). Every few seconds it reads
 * `dumpsys adb` and `cmd wifi status`; when the current network is not trusted
 * for Wireless debugging, it marks it "always allow" through
 * IAdbManager.allowWirelessDebugging, the call behind the system dialog's
 * "Always allow on this network". Owner decision, 2 November 2026: every
 * network the phone joins is trusted (docs/PHONE_AUTONOMY_POLICY.md).
 * It only adds the current network; it never turns Wireless debugging off,
 * removes networks or pairs devices.
 *
 * A network counts as untrusted when its BSSID is missing from the trusted
 * list in the `dumpsys adb` keystore dump, or when `is_trusted_network=false`.
 * The list check is needed because while the "Allow wireless debugging?"
 * dialog is up, SDK 37 reports a stale is_trusted_network=true with an empty
 * network_bssid.
 * Usage: app_process / trace.phone.WifiTrust [intervalSec]
 */
public final class WifiTrust {
  static final String MAC = "[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}";
  static final Pattern TRUSTED = Pattern.compile("is_trusted_network\\W+(true|false)");
  static final Pattern BSSID = Pattern.compile("BSSID[:=]\\s*\"?(" + MAC + ")");
  static final Pattern ANY_MAC = Pattern.compile(MAC);
  /** `SSID: "name",` in `cmd wifi status`; the lookbehind skips `BSSID:`. */
  static final Pattern SSID = Pattern.compile("(?<![A-Za-z])SSID: (\"[^\"]*\"|[^,\\s]+)");
  static final Pattern NETWORK_SSID = Pattern.compile("network_ssid=(\\S[^\\r\\n]*)");
  static final Pattern NETWORK_BSSID = Pattern.compile("network_bssid=(" + MAC + ")");
  /** Start of the adb_wifi block; the keystore dump (with the trusted list) comes before it. */
  static final String ADB_WIFI = "adb_wifi={";
  static final String NO_BSSID = "02:00:00:00:00:00";

  public static void main(String[] args) throws Exception {
    long intervalMs = (args.length > 0 ? Long.parseLong(args[0]) : 5) * 1000L;
    log("trust watcher started, every " + intervalMs / 1000 + " s");
    Quiet quiet = new Quiet();
    String lastAllowed = null;
    while (true) {
      String message = null;
      try {
        String dumpsys = run("dumpsys", "adb");
        Network network = network(dumpsys, run("cmd", "wifi", "status"));
        if (network == null) {
          if (Boolean.FALSE.equals(trusted(dumpsys))) message = "untrusted network but no BSSID (not on Wi-Fi?)";
        } else if (!network.untrusted) {
          lastAllowed = null;
        } else if (!network.bssid.equals(lastAllowed)) {
          String how = allow(network.bssid, network.ssid);
          lastAllowed = network.bssid;
          message = "allowed " + network.bssid + " " + network.ssid + " (" + how + ")";
        }
      } catch (Throwable error) {
        Throwable cause = error.getCause() != null ? error.getCause() : error;
        message = "error: " + cause;
      }
      if (quiet.shouldLog(message)) log(message);
      Thread.sleep(intervalMs);
    }
  }

  /** The current network and whether it needs trusting. */
  static final class Network {
    final String bssid;
    final String ssid;
    final boolean untrusted;

    Network(String bssid, String ssid, boolean untrusted) {
      this.bssid = bssid;
      this.ssid = ssid;
      this.untrusted = untrusted;
    }
  }

  /** The connected network from `cmd wifi status` (falling back to `dumpsys adb`), or null when there is none. */
  static Network network(String dumpsys, String status) {
    String bssid = bssid(status);
    if (bssid == null) bssid = first(NETWORK_BSSID, dumpsys);
    if (bssid == null) return null;
    bssid = bssid.toLowerCase();
    String ssid = ssid(status);
    if (ssid == null) ssid = first(NETWORK_SSID, dumpsys);
    Set<String> list = trustedList(dumpsys);
    boolean untrusted = Boolean.FALSE.equals(trusted(dumpsys)) || (list != null && !list.contains(bssid));
    return new Network(bssid, ssid == null ? "" : ssid.trim(), untrusted);
  }

  /** is_trusted_network from `dumpsys adb`, or null when the field is missing. */
  static Boolean trusted(String dumpsys) {
    Matcher m = TRUSTED.matcher(dumpsys);
    return m.find() ? Boolean.valueOf(m.group(1)) : null;
  }

  /**
   * Trusted BSSIDs from the keystore dump in `dumpsys adb` (lower case), or null when the dump has
   * no adb_wifi block. Base64 adb keys contain no colons, so every MAC before adb_wifi is a trusted
   * network.
   */
  static Set<String> trustedList(String dumpsys) {
    int end = dumpsys.indexOf(ADB_WIFI);
    if (end < 0) return null;
    Set<String> list = new LinkedHashSet<>();
    Matcher m = ANY_MAC.matcher(dumpsys.substring(0, end));
    while (m.find()) list.add(m.group().toLowerCase());
    return list;
  }

  /** The connected BSSID from `cmd wifi status`, or null (none, or redacted). */
  static String bssid(String status) {
    Matcher m = BSSID.matcher(status);
    while (m.find()) {
      String b = m.group(1).toLowerCase();
      if (!b.equals(NO_BSSID) && !b.equals("00:00:00:00:00:00")) return b;
    }
    return null;
  }

  /** The SSID from `cmd wifi status`, quoted as Android stores it ("name"), or null. */
  static String ssid(String status) {
    String ssid = first(SSID, status);
    return ssid == null || ssid.startsWith("<unknown") || ssid.equals("\"<unknown ssid>\"") ? null : ssid;
  }

  static String first(Pattern pattern, String text) {
    Matcher m = pattern.matcher(text);
    return m.find() ? m.group(1) : null;
  }

  static String allow(String bssid, String ssid) throws Exception {
    Class<?> sm = Class.forName("android.os.ServiceManager");
    IBinder binder = (IBinder) sm.getMethod("getService", String.class).invoke(null, "adb");
    if (binder == null) throw new IllegalStateException("no adb service");
    Object manager = Class.forName("android.debug.IAdbManager$Stub")
        .getMethod("asInterface", IBinder.class).invoke(null, binder);
    return invokeAllow(manager, bssid, ssid);
  }

  /**
   * Calls allowWirelessDebugging(true, bssid, ssid), the SDK 37 signature found on the S23, or the
   * AOSP allowWirelessDebugging(true, bssid) when the 3-argument one is missing. Returns which.
   */
  static String invokeAllow(Object manager, String bssid, String ssid) throws Exception {
    Method three;
    try {
      three = manager.getClass().getMethod("allowWirelessDebugging", boolean.class, String.class, String.class);
    } catch (NoSuchMethodException missing) {
      manager.getClass().getMethod("allowWirelessDebugging", boolean.class, String.class)
          .invoke(manager, true, bssid);
      return "2-arg";
    }
    three.invoke(manager, true, bssid, ssid);
    return "3-arg";
  }

  /** Logs a message once while it repeats; a quiet round (null) resets it. */
  static final class Quiet {
    private String last;

    boolean shouldLog(String message) {
      boolean fresh = message != null && !message.equals(last);
      last = message;
      return fresh;
    }
  }

  static String run(String... command) throws Exception {
    Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    try (InputStream in = process.getInputStream()) {
      byte[] buffer = new byte[8192];
      for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
    }
    process.waitFor();
    return new String(out.toByteArray(), StandardCharsets.UTF_8);
  }

  static void log(String message) {
    System.out.println(new java.util.Date() + " " + message);
    System.out.flush();
  }
}
