import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * 反射探针：只加载 Gradle 编译出来的 NativeControlCore.class。
 *
 * 输入为制表符分隔的命令，字符串字段使用 UTF-8 Base64，避免路径与 JSON
 * 在命令行上互相转义。输出为纯 ASCII NDJSON，由 Node 侧 JSON.parse 后断言。
 */
public final class NativeControlJniProbe {
  private static final String CLASS_NAME =
      "com.dsharnessmobile.shell.nativecontrol.NativeControlCore";

  private static Class<?> coreClass;
  private static Method initialize;
  private static Method exchange;
  private static Method exchangeNonblocking;

  private NativeControlJniProbe() {}

  public static void main(String[] args) throws Exception {
    BufferedReader input = new BufferedReader(
        new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintWriter output = new PrintWriter(
        new OutputStreamWriter(System.out, StandardCharsets.US_ASCII), true);

    String line;
    while ((line = input.readLine()) != null) {
      if (line.isEmpty()) {
        continue;
      }
      String[] fields = line.split("\\t", -1);
      String id = field(fields, 0);
      String op = field(fields, 1);
      String stateDir = decode(field(fields, 2));
      String appUidText = field(fields, 3);
      String payload = decode(field(fields, 4));
      try {
        if ("probe".equals(op)) {
          ensureLoaded();
          output.println(probeRecord(id));
          continue;
        }
        ensureLoaded();
        String response;
        if ("initialize".equals(op)) {
          int appUid = Integer.parseInt(appUidText);
          Object value = initialize.invoke(null, stateDir, appUid);
          response = stringResult(value, "initialize");
        } else if ("exchange".equals(op)) {
          Object value = exchange.invoke(null, payload);
          response = stringResult(value, "exchange");
        } else if ("exchangeNonblocking".equals(op)) {
          Object value = exchangeNonblocking.invoke(null, payload);
          response = stringResult(value, "exchangeNonblocking");
        } else if ("encodeFrame".equals(op)) {
          Method method = requireNative(coreClass, "encodeFrame", String.class, byte[].class);
          byte[] pixels = Base64.getDecoder().decode(field(fields, 5));
          response = stringResult(method.invoke(null, payload, pixels), "encodeFrame");
        } else if ("readImage".equals(op)) {
          Method method = coreClass.getDeclaredMethod("readImage", String.class);
          Object result = method.invoke(null, stateDir);
          if (result == null) throw new IllegalStateException("readImage returned no JNI object");
          Method metadata = result.getClass().getDeclaredMethod("getMetadata");
          Method jpeg = result.getClass().getDeclaredMethod("getJpeg");
          byte[] bytes = (byte[]) jpeg.invoke(result);
          response = "{\"metadata\":" + quote(stringResult(metadata.invoke(result), "metadata"))
              + ",\"jpeg\":" + (bytes == null ? "null" : quote(Base64.getEncoder().encodeToString(bytes))) + "}";
        } else {
          throw new IllegalArgumentException("unknown probe operation: " + op);
        }
        output.println(resultRecord(id, op, response));
      } catch (Throwable error) {
        output.println(errorRecord(id, op, error));
      }
    }
  }

  private static void ensureLoaded() throws Exception {
    if (coreClass != null) {
      return;
    }
    Class<?> loaded = Class.forName(CLASS_NAME, true, NativeControlJniProbe.class.getClassLoader());
    Method init = requireNative(loaded, "initialize", String.class, int.class);
    Method call = requireNative(loaded, "exchange", String.class);
    Method fast = requireNative(loaded, "exchangeNonblocking", String.class);
    coreClass = loaded;
    initialize = init;
    exchange = call;
    exchangeNonblocking = fast;
  }

  private static Method requireNative(Class<?> type, String name, Class<?>... params)
      throws NoSuchMethodException {
    Method method = type.getDeclaredMethod(name, params);
    int modifiers = method.getModifiers();
    if (!Modifier.isNative(modifiers)
        || !Modifier.isStatic(modifiers)
        || method.getReturnType() != String.class) {
      throw new IllegalStateException(
          name + " is not a static native method returning java.lang.String");
    }
    method.setAccessible(true);
    return method;
  }

  private static String probeRecord(String id) throws Exception {
    URL resource = coreClass.getResource("NativeControlCore.class");
    URL codeSource = coreClass.getProtectionDomain().getCodeSource() == null
        ? null
        : coreClass.getProtectionDomain().getCodeSource().getLocation();
    List<String> exports = new ArrayList<>();
    for (Method method : coreClass.getDeclaredMethods()) {
      if (Modifier.isStatic(method.getModifiers()) && Modifier.isNative(method.getModifiers())) {
        exports.add(methodJson(method));
      }
    }
    String methods = String.join(",", exports);
    return "{\"id\":" + quote(id)
        + ",\"op\":\"probe\""
        + ",\"invoked\":false"
        + ",\"probe\":{"
        + "\"className\":" + quote(coreClass.getName())
        + ",\"resource\":" + quote(resource == null ? "" : resource.toString())
        + ",\"codeSource\":" + quote(codeSource == null ? "" : codeSource.toString())
        + ",\"methods\":[" + methods + "]}}";
  }

  private static String methodJson(Method method) {
    StringBuilder params = new StringBuilder();
    Class<?>[] types = method.getParameterTypes();
    for (int index = 0; index < types.length; index++) {
      if (index > 0) {
        params.append(',');
      }
      params.append(quote(types[index].getName()));
    }
    return "{\"name\":" + quote(method.getName())
        + ",\"native\":true"
        + ",\"static\":true"
        + ",\"returnType\":" + quote(method.getReturnType().getName())
        + ",\"params\":[" + params + "]}";
  }

  private static String resultRecord(String id, String op, String response) {
    return "{\"id\":" + quote(id)
        + ",\"op\":" + quote(op)
        + ",\"invoked\":true"
        + ",\"response\":" + quote(response) + "}";
  }

  private static String errorRecord(String id, String op, Throwable error) {
    List<String> chain = new ArrayList<>();
    Throwable current = error;
    int depth = 0;
    while (current != null && depth < 8) {
      String message = current.getMessage();
      if (message != null && message.length() > 2000) {
        message = message.substring(0, 2000);
      }
      chain.add("{\"type\":" + quote(current.getClass().getName())
          + ",\"message\":" + quote(message == null ? "" : message) + "}");
      current = current.getCause();
      depth++;
    }
    return "{\"id\":" + quote(id)
        + ",\"op\":" + quote(op)
        + ",\"invoked\":false"
        + ",\"threw\":{\"chain\":[" + String.join(",", chain) + "]}}";
  }

  private static String stringResult(Object value, String op) {
    if (!(value instanceof String)) {
      throw new IllegalStateException(op + " returned " + (value == null ? "null" : value.getClass().getName()));
    }
    return (String) value;
  }

  private static String field(String[] fields, int index) {
    return index < fields.length ? fields[index] : "";
  }

  private static String decode(String value) {
    if (value.isEmpty()) {
      return "";
    }
    return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
  }

  private static String quote(String value) {
    StringBuilder out = new StringBuilder(value.length() + 16);
    out.append('"');
    for (int index = 0; index < value.length(); index++) {
      char ch = value.charAt(index);
      switch (ch) {
        case '"': out.append("\\\""); break;
        case '\\': out.append("\\\\"); break;
        case '\b': out.append("\\b"); break;
        case '\f': out.append("\\f"); break;
        case '\n': out.append("\\n"); break;
        case '\r': out.append("\\r"); break;
        case '\t': out.append("\\t"); break;
        default:
          if (ch < 0x20 || ch > 0x7e) {
            out.append("\\u");
            String hex = Integer.toHexString(ch);
            for (int pad = hex.length(); pad < 4; pad++) {
              out.append('0');
            }
            out.append(hex);
          } else {
            out.append(ch);
          }
      }
    }
    out.append('"');
    return out.toString();
  }
}
