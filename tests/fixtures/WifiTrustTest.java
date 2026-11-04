package trace.phone;

import java.util.Arrays;
import java.util.LinkedHashSet;

/**
 * Host-side checks for trace.phone.WifiTrust, run by tests/phone-wifi-trust.test.cjs.
 * The text fixtures copy the SDK 37 (S23) formats seen on 3 November 2026; the adb key is fake.
 */
public final class WifiTrustTest {
  static int failures;

  static void check(String name, Object expected, Object actual) {
    boolean ok = expected == null ? actual == null : expected.equals(actual);
    System.out.println((ok ? "ok " : "FAIL ") + name + (ok ? "" : ": expected " + expected + ", got " + actual));
    if (!ok) failures++;
  }

  /** `dumpsys adb` with the binary ABX keystore (trusted list) and the adb_wifi block. */
  static String dumpsys(String bssid, String ssid, boolean trusted) {
    String keystore = "    keystore=ABX\u0003\u0000\u0002keyStore\u0000version\u0000\u00022\u0000adbKey/\u0000key\u0000"
        + "QAAAAC39hD9bpTyW9fnAWqz6JWa+TQeZ08TGeuRpNYzQX+AQ28UGLY+xqiRblpjOPE\u0000"
        + "wifiAP/\u0000\u0005bssid\u0000\u001112:36:aa:06:52:a5/\u0000\u0004ssid\u00003\u00002\u0000"
        + "/\u0000\u00113c:e8:6e:44:34:d3/\u0000\t\"eduroam\"3\u00002\u0000"
        + "/\u0000\u00114C:D7:4A:7D:D2:3B/\u0000\u0012\"Thomas and Caden\"3\u00003\u0000\n";
    return "ADB MANAGER STATE (dumpsys adb):\n" + keystore
        + "    adb_wifi={\n      enabled=true\n      network_bssid=" + bssid + "\n      network_ssid=" + ssid
        + "\n      is_trusted_network=" + trusted + "\n    }\n";
  }

  static String status(String ssid, String bssid) {
    return "Wifi is enabled\nWifi scanning is always available\n==== Primary ClientModeManager instance ====\n"
        + "Wifi is connected to " + ssid + "\nWifiInfo: SSID: " + ssid + ", BSSID: " + bssid
        + ", MAC: 32:ce:d4:eb:14:b2, IP: /10.0.0.171, Security type: 4, Supplicant state: COMPLETED\n";
  }

  public static final class ThreeArg {
    public String called;

    public void allowWirelessDebugging(boolean always, String bssid, String ssid) {
      called = always + " " + bssid + " " + ssid;
    }
  }

  public static final class TwoArg {
    public String called;

    public void allowWirelessDebugging(boolean always, String bssid) {
      called = always + " " + bssid;
    }
  }

  public static void main(String[] args) throws Exception {
    String five = "\"MogesAIGirlfriend5\"";
    String fiveBssid = "12:36:aa:0d:52:a6";

    check("trusted list is every MAC before adb_wifi, lower case",
        new LinkedHashSet<>(Arrays.asList("12:36:aa:06:52:a5", "3c:e8:6e:44:34:d3", "4c:d7:4a:7d:d2:3b")),
        WifiTrust.trustedList(dumpsys(fiveBssid, five, false)));
    check("no adb_wifi block means no list", null, WifiTrust.trustedList("keystore=ABX 12:36:aa:06:52:a5"));
    check("empty wifiAP section is an empty list", new LinkedHashSet<String>(),
        WifiTrust.trustedList("keystore=ABX adbKey key QAAA\n adb_wifi={\n network_bssid=12:36:aa:0d:52:a6\n}"));

    check("SSID keeps Android's quotes and skips BSSID:", five, WifiTrust.ssid(status(five, fiveBssid)));
    check("SSID with spaces", "\"Thomas and Caden\"", WifiTrust.ssid(status("\"Thomas and Caden\"", fiveBssid)));
    check("unknown SSID is null", null, WifiTrust.ssid(status("<unknown ssid>", "02:00:00:00:00:00")));
    check("BSSID from cmd wifi status", fiveBssid, WifiTrust.bssid(status(five, fiveBssid)));

    // Dialog up: stale is_trusted_network=true and empty network_bssid, but the BSSID is not on the list.
    WifiTrust.Network dialog = WifiTrust.network(dumpsys("", "", true), status(five, fiveBssid));
    check("dialog up: untrusted because the BSSID is missing from the list", true, dialog.untrusted);
    check("dialog up: BSSID", fiveBssid, dialog.bssid);
    check("dialog up: SSID from cmd wifi status", five, dialog.ssid);

    WifiTrust.Network once = WifiTrust.network(dumpsys(fiveBssid, five, false), status(five, fiveBssid));
    check("allowed once: is_trusted_network=false is untrusted", true, once.untrusted);

    String two = "\"MogesAIGirlfriend\"";
    WifiTrust.Network trusted = WifiTrust.network(dumpsys("12:36:aa:06:52:a5", two, true), status(two, "12:36:AA:06:52:A5"));
    check("listed BSSID (any case) with is_trusted_network=true is trusted", false, trusted.untrusted);

    WifiTrust.Network stale = WifiTrust.network(dumpsys("12:36:aa:06:52:a5", two, false), status(two, "12:36:aa:06:52:a5"));
    check("is_trusted_network=false still triggers on a listed BSSID", true, stale.untrusted);

    WifiTrust.Network fallback = WifiTrust.network(dumpsys(fiveBssid, five, false), "Wifi is enabled\n");
    check("falls back to network_bssid and network_ssid from dumpsys adb", fiveBssid + " " + five,
        fallback.bssid + " " + fallback.ssid);

    check("not on Wi-Fi: no network", null,
        WifiTrust.network(dumpsys("", "", true), "Wifi is enabled\nWifi is disconnected\n"));

    ThreeArg three = new ThreeArg();
    check("3-arg signature is used when present", "3-arg", WifiTrust.invokeAllow(three, fiveBssid, five));
    check("3-arg call passes (true, bssid, ssid)", "true " + fiveBssid + " " + five, three.called);
    TwoArg twoArg = new TwoArg();
    check("falls back to the 2-arg signature", "2-arg", WifiTrust.invokeAllow(twoArg, fiveBssid, five));
    check("2-arg call passes (true, bssid)", "true " + fiveBssid, twoArg.called);
    try {
      WifiTrust.invokeAllow(new Object(), fiveBssid, five);
      check("neither signature throws", "NoSuchMethodException", "no exception");
    } catch (NoSuchMethodException expected) {
      check("neither signature throws", "NoSuchMethodException", "NoSuchMethodException");
    }

    WifiTrust.Quiet quiet = new WifiTrust.Quiet();
    String error = "error: java.lang.NoSuchMethodException: allowWirelessDebugging";
    StringBuilder logged = new StringBuilder();
    for (String message : new String[] {error, error, error, "error: other", "error: other", null, error, null, null}) {
      logged.append(quiet.shouldLog(message) ? "1" : "0");
    }
    check("a repeated message is logged once; a quiet round resets it", "100100100", logged.toString());

    if (failures > 0) {
      System.out.println(failures + " failed");
      System.exit(1);
    }
    System.out.println("all passed");
  }
}
