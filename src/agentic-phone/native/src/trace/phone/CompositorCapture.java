package trace.phone;

import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.hardware.HardwareBuffer;
import android.os.IBinder;
import android.view.Display;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/** Experimental default-display capture through the shell's WindowManager connection. */
final class CompositorCapture {
  static final class Unavailable extends IllegalStateException {
    Unavailable(String message) { super(message); }
  }

  private final Object windowManager;
  private final Object displayManager;
  private final Method captureDisplay;
  private final Method newListener;
  private final Method getBuffer;
  private final Method getHardwareBuffer;
  private final Method getColorSpace;
  private final Method getDisplayInfo;
  private final Field width;
  private final Field height;
  private final Field rotation;

  private static Class<?> findCaptureApi() throws ClassNotFoundException {
    try {
      // Android 16 QPR2 moved the WindowManager capture types into ScreenCaptureInternal.
      return Class.forName("android.window.ScreenCaptureInternal");
    } catch (ClassNotFoundException missingInternal) {
      return Class.forName("android.window.ScreenCapture");
    }
  }

  private static Object getWindowManager() throws ReflectiveOperationException {
    // WindowManagerGlobal initializes application animation state absent in app_process.
    Class<?> services = Class.forName("android.os.ServiceManager");
    Object binder = services.getMethod("getService", String.class).invoke(null, "window");
    if (binder == null) throw new Unavailable("WindowManager service unavailable");
    Class<?> stub = Class.forName("android.view.IWindowManager$Stub");
    return stub.getMethod("asInterface", IBinder.class).invoke(null, binder);
  }

  CompositorCapture() throws ReflectiveOperationException {
    Class<?> screen = findCaptureApi();
    String apiName = screen.getName();
    Class<?> args = Class.forName(apiName + "$CaptureArgs");
    Class<?> listener = Class.forName(apiName + "$ScreenCaptureListener");
    Class<?> sync = Class.forName(apiName + "$SynchronousScreenCaptureListener");
    Class<?> screenshot = Class.forName(apiName + "$ScreenshotHardwareBuffer");
    Class<?> wm = Class.forName("android.view.IWindowManager");
    Class<?> dmGlobal = Class.forName("android.hardware.display.DisplayManagerGlobal");
    Class<?> displayInfo = Class.forName("android.view.DisplayInfo");
    windowManager = getWindowManager();
    displayManager = dmGlobal.getMethod("getInstance").invoke(null);
    captureDisplay = wm.getMethod("captureDisplay", int.class, args, listener);
    newListener = screen.getMethod("createSyncCaptureListener");
    getBuffer = sync.getMethod("getBuffer");
    getHardwareBuffer = screenshot.getMethod("getHardwareBuffer");
    getColorSpace = screenshot.getMethod("getColorSpace");
    getDisplayInfo = dmGlobal.getMethod("getDisplayInfo", int.class);
    width = displayInfo.getField("logicalWidth");
    height = displayInfo.getField("logicalHeight");
    rotation = displayInfo.getField("rotation");
  }

  Main.Frame capture() throws ReflectiveOperationException {
    Object before = getDisplayInfo.invoke(displayManager, Display.DEFAULT_DISPLAY);
    if (before == null) throw new Unavailable("No default display");
    Object listener = newListener.invoke(null);
    // Default capture arguments exclude secure and protected content.
    captureDisplay.invoke(windowManager, Display.DEFAULT_DISPLAY, null, listener);
    Object result = getBuffer.invoke(listener);
    if (result == null) throw new Unavailable("Compositor returned no frame");
    try (HardwareBuffer buffer = (HardwareBuffer) getHardwareBuffer.invoke(result)) {
      Object after = getDisplayInfo.invoke(displayManager, Display.DEFAULT_DISPLAY);
      if (after == null || width.getInt(before) != width.getInt(after)
          || height.getInt(before) != height.getInt(after)
          || rotation.getInt(before) != rotation.getInt(after)) {
        throw new Unavailable("Display geometry changed during capture");
      }
      Main.Frame frame = new Main.Frame();
      frame.width = width.getInt(after);
      frame.height = height.getInt(after);
      ColorSpace color = (ColorSpace) getColorSpace.invoke(result);
      long size = (long) frame.width * frame.height * 4;
      if (buffer == null) throw new Unavailable("No hardware buffer");
      if (frame.width != buffer.getWidth() || frame.height != buffer.getHeight()) {
        throw new Unavailable("Buffer " + buffer.getWidth() + "x" + buffer.getHeight()
            + " differs from display " + frame.width + "x" + frame.height);
      }
      if (frame.width <= 0 || frame.height <= 0 || size > (20 << 20)) {
        throw new Unavailable("Display outside supported capture size");
      }
      if (buffer.getFormat() != HardwareBuffer.RGBA_8888) {
        throw new Unavailable("Unsupported buffer format " + buffer.getFormat());
      }
      if (color == null || !color.isSrgb()) {
        throw new Unavailable("Unsupported buffer color space " + (color == null ? "null" : color.getName()));
      }
      Bitmap hardware = Bitmap.wrapHardwareBuffer(buffer, color);
      if (hardware == null) throw new Unavailable("Unable to wrap compositor buffer");
      try {
        Bitmap pixels = hardware.copy(Bitmap.Config.ARGB_8888, false);
        if (pixels == null) throw new Unavailable("Unable to read compositor pixels");
        if (pixels.getRowBytes() != frame.width * 4) {
          pixels.recycle();
          throw new Unavailable("Unsupported compositor pixel stride");
        }
        frame.bitmap = pixels;
        frame.backend = "compositor";
        return frame;
      } finally {
        hardware.recycle();
      }
    }
  }
}
