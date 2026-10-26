# Non-enumerable array compatibility methods

Issue #621: the six missing-array-method shims in #619 used assignment to `Array.prototype`. This made them enumerable, so `for...in` over `[3, 1]` returned six method names in addition to indices. Existing value comparisons did not inspect property descriptors.

Install missing methods with `Object.defineProperty`, keeping writable/configurable true and enumerable false. Native guards and algorithms remain intact. The regression executes production bytes in a realm with all six methods removed and checks descriptors and array enumeration. Delivery markers follow the new installation syntax.

Validation: 65 plugin tests, injection smoke checks, and eight settings-probe self-tests passed. A controlled mutation to enumerable true failed the new regression. Existing function-extraction tests require LF checkout boundaries; no line-ending behavior change is included.

API 35 / WebView 124 received a runtime hot-push in both profiles. CDP removed all six native methods, evaluated the actual served polyfill, and verified restored behavior, descriptors and index-only enumeration. Existing bilingual probes from #601 passed 39 checks in each orientation. The parent Chinese-only probe failed two selectors on the English page; these failures are retained and not counted as passing. Actual ADB taps opened model settings in both orientations; the portrait provider editor was opened and scrolled without saving credentials. Screenshots were inspected. This covers local runtime validation, not release APK qualification.
