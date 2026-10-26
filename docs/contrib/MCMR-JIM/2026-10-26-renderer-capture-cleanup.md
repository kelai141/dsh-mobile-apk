# Bounded renderer capture cleanup

**A screenshot join timeout does not cancel a blocked pipe reader (#607).** The remote may retain a writer after returning failure or timing out. The old host returned while its reader remained blocked until the writer closed. The reader now polls with a bounded interval, owns its ParcelFileDescriptor input stream and observes cancellation. Every return and exception closes both local ends and joins the cancelled reader; interrupted callers retain their signal, and empty or failed reads are rejected. Android fault injection reproduced both leaked-reader paths while a 256 KiB successful capture drained correctly.

## Verification

The controlled Android baseline left blocked readers after failure and timeout. All six capture cases pass on Android 15 with WebView 124, including failure, timeout, exception, interruption, empty output and successful 256 KiB transfer. The complete focused device suite passes all 64 cases across 13 classes, including real renderer service reconnection and recovery-marker cleanup. The integrated APK passes all 1,842 Kotlin tests.

Browser lifecycle and panel CDP regressions pass. WebView verification passes all 39 checks in each orientation. ADB interaction in portrait and landscape completes file creation, reading and cleanup through the visible console; screenshots and CDP output confirm the results. The test APK and installed application are tied to the same integration source; this branch contains the identical capture implementation.
