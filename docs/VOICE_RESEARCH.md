# A8 voice input: speech-to-text routes on the S23 (research, 2–3 November 2026)

Task A8 in [AUTONOMY_TASKS.md](AUTONOMY_TASKS.md). This doc compares the routes that could turn
the owner's speech into text for a phone Claude session, with numbers measured on the S23 on
3 Nov 2026 ([evidence](../evidence/research/a8-voice-2026-11-03.json)). The test audio is **not
the owner's voice**: 20 LibriSpeech test-clean utterances plus 10 synthetic (Piper TTS) phone
commands, each clean and with pink noise at 10 dB SNR, 40 clips and 227 s in total. No microphone
was used. Raw audio and per-clip transcripts stay off Git.

## Device facts (read over adb, 2–3 Nov 2026, no microphone used)

| Fact | Value | Source |
| --- | --- | --- |
| Android, SDK, build | 17, 37, `CP2A.260605.016.S918USQU8GZIF` | `getprop` |
| SoC, RAM, CPUs online | SM8550, 11.3 GB, 6 | `getprop ro.soc.model`, `/proc/meminfo`, `nproc` |
| Default recognizer | `com.google.android.tts/…GoogleTTSRecognitionService` (`googletts…20260928.02`) | `settings get secure voice_recognition_service` |
| On-device recognizer service | `com.google.android.as` `AiAiSpeechRecognitionService` present | `dumpsys package` (handoff 10) |
| On-device recognizer config | `com.google.android.as/…AiAiSpeechRecognitionService`, set by an overlay (the `framework-res.apk` base value is empty) | `cmd overlay lookup android android:string/config_defaultOnDeviceSpeechRecognitionService` (3 Nov 2026) |
| Termux:API | app installed; `termux-speech-to-text`, `termux-microphone-record` present | `dumpsys package com.termux.api`, Termux `pkg` (handoff 10) |
| Termux:API from Debian | works: the Termux bin dir is on Debian's `PATH`, and `termux-battery-status` run in Debian returned its JSON (rc 0) | Debian diag script over Termux (3 Nov 2026) |
| Debian (proot) speech tools | none: python3 only, no whisper.cpp, ffmpeg or sox. Has git, make, gcc, g++, curl; no cmake. 13 GB free | handoff 10 inventory; Debian diag (3 Nov 2026) |

The owner's existing `claude-voice` project already does voice end to end: the Android app
`com.claudevoice.listen` uses `SpeechRecognizer.createSpeechRecognizer` with
`LANGUAGE_MODEL_FREE_FORM` and no `EXTRA_PREFER_OFFLINE`, sends the text to a local bridge on
`127.0.0.1:48766` (token auth, one `claude -p` session), and speaks replies with Android TTS. The
bridge takes text only.

## How it was measured

- **Android routes:** a small debug app feeds each WAV to `SpeechRecognizer` through
  `EXTRA_AUDIO_SOURCE` at real time, then 0.5 s of silence; one app launch per clip with a 2 s gap
  (back-to-back clips in one process mostly failed with busy/client errors). Time runs from
  `startListening` to `onResults`, so it includes the clip itself.
- **whisper.cpp** 1.9.5-dev, arm64 build run from `adb shell`, 4 threads, a fresh process per clip
  (model load included). The small.en run was interrupted by a USB disconnect and resumed.
- **Word error rate (WER):** lowercase, punctuation stripped, numbers matched as spoken words or
  digits. "Commands" below means the 20 command clips (mean 3.1 s), which is the live use case.

## Results

| Route | WER, commands | WER, all 40 | Latency, commands (median) | Failed clips | Works with network off |
| --- | --- | --- | --- | --- | --- |
| 1. Android default (`createSpeechRecognizer`, as claude-voice) | 6.3% | 18.5%* | 0.18 s after the clip ends | 0 / 40 | yes, falls back to the on-device model |
| 2a. Android on-device (`createOnDeviceSpeechRecognizer`) | 6.7% | 23.4%* | 0.12 s after the clip ends | 13 / 40 (`ERROR_CLIENT`, no match) | yes |
| 2b. Android default + `EXTRA_PREFER_OFFLINE` | 6.0% | 25.3%* | 0.03 s after the clip ends | 1 / 40 (no match) | yes |
| 4. whisper.cpp tiny.en | 9.5% | 5.8% | 1.1 s after recording | 0 | yes |
| 4. whisper.cpp base.en | 7.0% | 4.6% | 2.1 s after recording (0.54× real time overall) | 0 | yes |
| 4. whisper.cpp small.en | 4.4% | 3.3% | 6.2 s after recording (1.7× real time) | 0 | yes |
| 4. whisper.cpp small.en-q5_1 | 4.4% | 3.8% | 9.0 s after recording (slower than unquantized) | 0 | yes |

\* Android routes run as a single utterance and stop at the first pause, so 4 to 8 of the 20 long
LibriSpeech clips came back cut short. Their all-40 WER measures that cut-off, not word accuracy.

Route 3 (`termux-speech-to-text`) takes live microphone audio only, so it was not run on files; it
calls the same default recognizer as route 1.

**Where audio goes.** With airplane mode on, Wi-Fi off and a failed ping (Samsung keeps Wi-Fi on
in airplane mode, so the first attempt did not count), every route above returned the right
text for the same command clip. Route 2b matched route 2a word for word on 26 of 27 clips while
online, so the offline flag selects the on-device model. Route 1 online matched it on only about
half the clips and wrote in a different (lowercase) style, so it most likely sends audio to Google
when the network is up; this is inferred from output, not from packet capture.

**Permissions.** Route 2a worked without `RECORD_AUDIO`. Route 1 and 2b returned
`ERROR_INSUFFICIENT_PERMISSIONS` (or busy right after one) on every clip until the test app was granted `RECORD_AUDIO`
(owner-approved; the app never opened the microphone).

## Recommendation

- **Live tasks spoken to the phone: route 2b**, the default recognizer with
  `EXTRA_PREFER_OFFLINE = true`. Best command WER of the Android routes (6.0%), result within
  0.1 s of the speaker stopping, 1 failure in 40, and it uses the on-device model. In claude-voice
  this is a one-line change (add the extra). Avoid route 2a for now: same model, but
  `createOnDeviceSpeechRecognizer` failed a third of the clips on this build.
- **Transcripts of recordings: route 4 with base.en** (4.6% WER overall, about half real time).
  Use small.en (3.3%) when accuracy matters more than time; it runs at 1.7× real time. Skip
  q5_1 on this phone: it is slower than small.en for no accuracy gain.
- A1 tiers still apply: recording the microphone stays **ask first**. Route 1 as claude-voice
  uses it today likely sends audio off the phone, which is also ask-first.

## Still open

1. Owner-voice check: record 3 to 5 owner phrases with `termux-microphone-record` (ask first,
   files stay on the phone) and confirm route 2b and base.en hold up on a real voice and mic.
2. Confirm route 2b keeps audio local while online with a traffic check, if that guarantee is
   needed beyond the output match above.
3. Then build `phone_transcribe` or a script (A8 follow-up): whisper.cpp in Debian needs a build
   there (it was built for Android here) or the arm64 binary copied in.
