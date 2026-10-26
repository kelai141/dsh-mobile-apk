# Capture pipe writer ownership

## Failure and cause

The reader in `CapturePipeDrain` cannot reach EOF until every write descriptor closes. The host adapter retained its original writer until cleanup after the reader join. A real Android pipe carrying a valid PNG larger than 256 KiB consequently returned null after 15.248 seconds, although all ten JVM helper tests passed.

Closing only the host writer made six Android pipe cases pass, but a real renderer Binder capture still returned null. The remote renderer constructed `FileOutputStream` from a borrowed raw `FileDescriptor`; closing that stream did not release the received `ParcelFileDescriptor`.

## Repair

Close the host writer in the capture callback's `finally`, before the drain helper joins. On the renderer side, use `ParcelFileDescriptor.AutoCloseOutputStream` and a final descriptor close covering allocation and drawing failures. Keep concurrent draining, cancellation, receipt handling, and the parent branch's empty-payload policy.

## Verification

- The unfixed parent failed the large valid-PNG Android regression after 15.248 seconds.
- The host-only repair passed six pipe cases but failed the additional real Binder capture. Both failing runs remain available as negative controls.
- The complete repair passed all seven `RendererCapturePipeDeviceTest` cases, including a real `:browser` service returning a decodable 512 by 512 PNG in under five seconds.
- The ten `CapturePipeDrainTest` JVM cases, execution-map check, and Kotlin comment check passed.
- Browser and user interaction validation is recorded separately in the repair PR; these native tests do not establish release APK qualification.

The development APK reuses the existing snapshot and is not a release candidate. An available profile API may make the ordinary browser UI choose that path; the explicit Binder regression covers the process renderer regardless of the device's preferred isolation tier.
