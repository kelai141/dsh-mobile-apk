# Fail Closed When Screenshot Cache Cannot Be Listed

## Problem

After pruning, the screenshot publication check treated a null directory listing as an empty cache. The size and file-count limits were therefore reported as satisfied without inspecting the directory.

## Change

Treat a null or failed listing as publication failure and attempt to remove the capture. Add regression coverage for both a null listing and a listing exception while the capture file exists.

## Verification

- ShotCachePolicyNullListingTest passed for null and exception paths.
- Device validation was not performed.
