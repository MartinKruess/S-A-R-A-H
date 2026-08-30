# Startup performance plan

## Scope

- Reduce the cold-start time without showing the application before its required services are ready.
- Keep the existing splash readiness contract authoritative.
- Preserve independent degradation, recovery, and shutdown behavior for router and voice services.
- Keep the opt-in boot trace for future model and provider comparisons.

## Baseline

Measured on the Windows development system with `SARAH_BOOT_TRACE=1` during a real cold start:

| Component | Start relative to lifecycle | Duration | Ready relative to lifecycle |
| --- | ---: | ---: | ---: |
| Ollama API | 0.258 s | 0.384 s | 0.642 s |
| Router model and service | 0.002 s | 10.583 s | 10.585 s |
| Whisper | 10.587 s | 9.197 s | 19.784 s |
| Piper | 19.784 s | 0.086 s | 19.870 s |
| Complete lifecycle | 0.000 s | 19.874 s | 19.874 s |

The router and voice services currently start sequentially. Piper and the remaining services are too small to provide a meaningful optimization by themselves.

## Change

1. Start the router path immediately.
2. Start the voice path after an abortable 3,000 ms delay.
3. Wait for both paths to reach their real terminal startup state before completing the lifecycle.
4. Continue with the remaining services in their established order.
5. Abort the delayed path during shutdown and suppress late readiness updates.

The delay is a load-staggering offset, not a readiness assumption. Router and Whisper readiness continues to come from their existing initialization results.

## Expected result

- Arithmetic target without resource contention: approximately 12.3 seconds.
- Practical target with CPU, disk, and GPU contention: approximately 12.5 to 14 seconds.
- Expected improvement over the baseline: approximately 5.9 to 7.4 seconds.

## Verification

- Automated lifecycle test for the normal staggered startup.
- Router and voice failure tests preserve degraded-state behavior.
- Shutdown during the delay cancels pending startup work.
- No lifecycle-ready publication before both startup paths settle.
- Real Windows cold-start measurement with the opt-in boot trace.

## First optimized cold-start result

Measured on the same Windows development system after introducing the 3,000 ms voice offset:

| Component | Start relative to lifecycle | Duration | Ready relative to lifecycle |
| --- | ---: | ---: | ---: |
| Router service | 0.003 s | 12.420 s | 12.423 s |
| Whisper | 3.012 s | 10.709 s | 13.721 s |
| Piper | 13.721 s | 0.107 s | 13.828 s |
| Reminders | 13.829 s | 0.002 s | 13.831 s |
| Complete lifecycle | 0.000 s | 13.832 s | 13.832 s |

- Improvement over the 19.874 s baseline: 6.042 seconds (30.4%).
- Router and Whisper overlapped as intended; their individual durations increased under shared startup load, but the total remained within the practical target range.
- Manual observation confirmed that the splash completed noticeably faster and did not expose the application before lifecycle readiness.
- The 3,000 ms offset remains unchanged to retain approximately 1.3 seconds of observed completion margin between router and Whisper under this run.

## Out of scope

- Changing router or worker models.
- Changing model quantization or GPU-layer settings.
- Replacing Piper with another TTS provider.
- Moving reminder or curator work into the splash-critical path.
