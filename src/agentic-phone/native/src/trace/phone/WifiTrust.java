package trace.phone;

import android.os.IBinder;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Wi-Fi trust watcher. Runs on the device as the shell user through app_process
 * (started by scripts/phone-boot-adb.cjs). Every few seconds it reads
 * `dumpsys adb`; when the current network is not trusted for Wireless
 * debugging, it marks it "always allow" through
 * IAdbManager.allowWirelessDebugging(true, bssid), the call behind the system
 * dialog's "Always allow on this network". Owner decision, 2 November 2026:
 * every network the phone joins is trusted (docs/PHONE_AUTONOMY_POLICY.md).
 * It only adds the current network; it never turns Wireless debugging off,
 * removes networks or pairs devices.
 * Usage: app_process / trace.phone.WifiTrust [intervalSec]
 */
public final class WifiTrust {
  static final Pattern TRUSTED = Pattern.compile("is_trusted_network\\W+(true|false)");
  static final Pattern BSSID = Pattern.compile("BSSID[:=]\\s*\"?([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})");
  static final String NO_BSSID = "02:00:00:00:00:00";

  public static void main(String[] args) throws Exception {
    long intervalMs = (args.length > 0 ? Long.parseLong(args[0]) : 5) * 1000L;
    log("trust watcher started, every " + intervalMs / 1000 + " s");
    String lastAllowed = null;
    while (true) {
      try {
        Boolean trusted = trusted(run("dumpsys", "adb"));
        if (Boolean.FALSE.equals(trusted)) {
          String bssid = bssid(run("cmd", "wifi", "status"));
          if (bssid == null) {
            log("untrusted network but no BSSID (not on Wi-Fi?)");
          } else if (!bssid.equals(lastAllowed)) {
            allow(bssid);
            lastAllowed = bssid;
            log("allowed " + bssid);
          }
        } else if (Boolean.TRUE.equals(trusted)) {
          lastAllowed = null;
        }
      } catch (Throwable error) {
        log("error: " + error);
      }
      Thread.sleep(intervalMs);
    }
  }

  /** is_trusted_network from `dumpsys adb`, or null when the field is missing. */
  static Boolean trusted(String dumpsys) {
    Matcher m = TRUSTED.matcher(dumpsys);
    return m.find() ? Boolean.valueOf(m.group(1)) : null;
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

  static void allow(String bssid) throws Exception {
    Class<?> sm = Class.forName("android.os.ServiceManager");
    IBinder binder = (IBinder) sm.getMethod("getService", String.class).invoke(null, "adb");
    if (binder == null) throw new IllegalStateException("no adb service");
    Object manager = Class.forName("android.debug.IAdbManager$Stub")
        .getMethod("asInterface", IBinder.class).invoke(null, binder);
    manager.getClass().getMethod("allowWirelessDebugging", boolean.class, String.class)
        .invoke(manager, true, bssid);
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
