# A8 voice input: speech-to-text routes on the S23 (research, 2 November 2026)

Task A8 in [AUTONOMY_TASKS.md](AUTONOMY_TASKS.md). This doc compares the routes that could turn
the owner's speech into text for a phone Claude session. **No owner-voice samples were recorded
yet** (the owner deferred them on 2 Nov 2026), so latency and accuracy are `not_run` below. The
A8 done-when ("a recommended route with measured numbers") is not met until those runs happen.

## Device facts (read over adb, 2 Nov 2026, no microphone used)

| Fact | Value | Source |
| --- | --- | --- |
| Android SDK | 37 | `getprop ro.build.version.sdk` |
| SoC, RAM, CPUs online | SM8550, 11.3 GB, 6 | `getprop ro.soc.model`, `/proc/meminfo`, `nproc` |
| Default recognizer | `com.google.android.tts/…GoogleTTSRecognitionService` | `settings get secure voice_recognition_service` |
| On-device recognizer service | `com.google.android.as` `AiAiSpeechRecognitionService` present | `dumpsys package` (handoff 10) |
| Termux:API | app installed; `termux-speech-to-text`, `termux-microphone-record` present | `dumpsys package com.termux.api`, Termux `pkg` (handoff 10) |
| Debian (proot) speech tools | none: python3 only, no whisper.cpp, ffmpeg or sox | handoff 10 inventory |

The owner's existing `claude-voice` project already does voice end to end: the Android app
`com.claudevoice.listen` uses `SpeechRecognizer.createSpeechRecognizer` with
`LANGUAGE_MODEL_FREE_FORM` and no `EXTRA_PREFER_OFFLINE`, sends the text to a local bridge on
`127.0.0.1:48766` (token auth, one `claude -p` session), and speaks replies with Android TTS. The
bridge takes text only.

## Routes

| Route | Where audio goes | Setup cost | Latency / accuracy | Notes |
| --- | --- | --- | --- | --- |
| 1. Android recognizer, default (as claude-voice does today) | May go to Google servers: no offline flag is set. TODO(verify) | none, already built | not_run | Streams partial results; good for live dictation. |
| 2. Android on-device recognizer (`createOnDeviceSpeechRecognizer`, SDK 31+) | Stays on the phone (Android's documented contract). TODO(verify) on this device | small change to claude-voice | not_run | Same API as route 1; `isOnDeviceRecognitionAvailable` must return true. TODO(verify) |
| 3. Termux:API `termux-speech-to-text` | Uses the default recognizer, so same as route 1. TODO(verify) | none, callable from Termux; from Debian only if the Termux bin dir is reachable. TODO(verify) | not_run | Cheapest baseline for a session: one shell command returns text. Live utterance only, no file input. |
| 4. whisper.cpp in Debian on a recording (`termux-microphone-record`) | Stays on the phone | build whisper.cpp and a model in proot (no ffmpeg yet; needs WAV 16 kHz) | not_run; CPU only, expect seconds per utterance with a small model. TODO(verify) | Only route that transcribes existing recordings, which A8 also asks for. |

## Recommendation (provisional, pending the voice runs)

- **Live tasks spoken to the phone:** route 2 (on-device recognizer) if the device reports it
  available, else route 3 as the cheapest baseline. Both reuse what is installed.
- **Transcripts of recordings:** route 4, because routes 1 to 3 cannot take an audio file.
- A1 tiers still apply: recording the microphone and any route that may send audio off the phone
  stay **ask first**.

## Next runs (owner present, ask-first)

1. Record 3 to 5 short owner phrases with `termux-microphone-record`; keep the files on the phone
   (no raw audio in Git).
2. Time and score routes 2, 3 and 4 on the same phrases (word error by hand, wall-clock seconds).
3. Check route 1 vs 2 audio egress with airplane mode on: a route that still works offline keeps
   audio on the phone.
4. Fill the table above, pick a route, then build `phone_transcribe` or a script (A8 follow-up).
