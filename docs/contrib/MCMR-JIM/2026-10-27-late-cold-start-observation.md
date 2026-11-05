# Observe a late authorized cold start

The device retained `native-repair/required=true` and two spent retries. The one permitted cold-start attempt did launch an engine, and a later read-only bridge probe returned HTTP 200 with valid authentication. The Activity nevertheless remained on its native startup guide with an about:blank WebView.

The foreground monitor returned immediately whenever the durable repair gate existed, even for the cold-start attempt already authorized behind that historical gate. Returning to the foreground also replaced the in-flight phase and skipped the monitor. Once the startup polling budget ended, no observer could show a late healthy page; the page-ready report needed to clear the gate could therefore never arrive.

Passive observation now continues only for that authorized in-flight attempt. Resume restarts the observer and returns without spending another attempt or starting a service. New repair decisions, active repair, queued retry, user shutdown, plugin failure and lifecycle guards continue to block their existing paths. HTTP health alone does not reset the durable retry ledger; page-ready convergence still does.

Validation:

- The same real-Activity Android suite on the old installed package fails late-page visibility and resume observation, while newly armed repair rejection passes. The initial fixed package passes all three.
- The final package also rechecks the gate when the HTTP result reaches the UI thread. Four actual Android cases pass, including arming repair while a controlled HTTP request is blocked and rejecting its late successful response.
- A subsequent actual startup of that final package presents the main WebView after about 23 seconds of recorded observation. Final portrait and landscape CDP checks are recorded separately from the earlier package checks.
- All 38 focused JVM cases pass: repair policy, startup retry, lifecycle ownership and authentication policy. Only the additional repair policy case raises the baseline.
- Actual cold start begins with the historical gate intact (`required=true`, retries two), presents the real main WebView after about 46 seconds of recorded observation and converges to required false/retries zero without manual retry or an engine restart. A real Home/foreground round trip preserves interaction.
- Portrait and landscape WebView checks each pass 46 assertions. Both actual console tasks complete backup, modification, restoration, byte comparison and cleanup. Failed input preconditions remain recorded separately; the wide task resumes without recreating the existing directory, and final markers are read back.

The telemetry import error seen in the engine log is a separate observation; this change does not establish or repair its cause and does not promise all cold starts finish inside 90 seconds. UI task inputs do not change with the final late-callback guard; that added race is covered by the final native suite. All packages are local development artifacts, not release candidates.


## Main-targeted continuation

The publication parent entered main while its startup child #644 closed without merging. The same startup runtime now continues independently against main. Its runtime blobs match the combined validation source 8184cfc5. That development package passed 14 Android tests (five ownership, five publication and four startup), portrait and landscape WebView checks (46 each), and actual backup/restore/byte-comparison/cleanup tasks in both orientations. The earlier 38 focused startup JVM results and controlled native negative remain valid for the unchanged startup inputs. No full suite or release-candidate rerun is claimed. The publication integration note records exact inputs, failed automation attempts and completed evidence.
