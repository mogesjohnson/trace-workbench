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

## Owner-voice check (3 Nov 2026)

The owner recorded the five prompted commands below with `termux-microphone-record` on the S23
([evidence](../evidence/research/a8-voice-owner-2026-11-03.json)). The audio stayed on the phone,
only transcript text left it, and the clips were deleted after scoring. **Other people were talking
in the background**, so treat these numbers as a noisy-room reading; re-run in a quiet room and
replace this section if the numbers need to be firmer.

| Route | WER (5 clips) | Failures |
| --- | --- | --- |
| 2b. Android default + `EXTRA_PREFER_OFFLINE` (Wi-Fi on) | 13.9% | 0 / 5 |
| 4. whisper.cpp base.en | 25.0% | 0 / 5 |

Both routes dropped the same opening words on three clips ("turn on", "send a", "summarize"), so
most of the error is the clip start, not the recognizer: the recording script prompted before
`termux-microphone-record` had started. A re-run should start the recorder first, then prompt.
Without those lost words, route 2b was word-perfect and base.en misheard "set a" as "that" and
"a" as "the". The ranking holds: route 2b stays the live route on a real voice and mic.

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

1. Optional quiet-room re-run of the owner-voice check, with the recorder started before the
   prompt; it replaces the section above.
2. Traffic capture for route 2b: not needed. The owner accepted the output match above as enough
   (3 Nov 2026); the "on-device" claim stays labelled as inferred, not captured.
3. `phone_transcribe` (A8 follow-up): **built 3 Nov 2026.** `scripts/phone/install-whisper.sh`
   builds whisper.cpp v1.9.5 in the Debian proot with Debian's own gcc and cmake (apt) and installs
   `phone-transcribe` with base.en. On the phone it transcribed the jfk sample exactly (11 s of audio
   in 4.2 s, model load included) and the noisy command clips in about 3.6 s each. The
   `phone_transcribe` MCP tool returned the same text from the PC over SSH
   ([evidence](../evidence/research/a8-phone-transcribe-2026-11-03.json)). small.en is installed
   too (`install-whisper.sh small.en`): `phone-transcribe -m small.en` got the jfk words exact in
   about 16.5 s (1.5× real time), on the phone and over SSH from the PC. Live `--record 8`
   test by the owner (approved, 3 Nov 2026, soft speech in a library), reference "open termux
   and run the phone bench": base.en "Open Turmox and run the phone badge." (2 of 7 words wrong,
   3.7 s), small.en on the same clip "Open termox and run the phone bench." (1 of 7, 15.6 s).
   Two practical points: `--keep` must be a path Termux can reach (the Termux home, not Debian's
   `/tmp`), and the speaker should start at the phone's green mic indicator with about 3 s of
   slack, since the PC-side prompt is invisible to them and 5 s cut the sentence off. Clips were
   deleted after the runs. Call from phone Claude: **passed 4 Nov 2026.** A Claude app Code session on
   `localhost · phone-work` called the `phone_transcribe` MCP tool on `jfk.wav` and got the words
   exact, in 20.7 s ([evidence](../evidence/research/a8-phone-claude-transcribe-2026-11-04.json)).
   That is 5 times the 3 Nov time; an SSH re-run right after took 15.3 s while the phone had 10.5 of
   11 GB RAM and 6.4 GB swap in use. The cause is not verified.
4. claude-voice: add `EXTRA_PREFER_OFFLINE = true` (owner approved). Done 3 Nov 2026 in the
   separate private claude-voice repository (its PR 1). The owner installed the build and spoken
   commands worked. Network-off test, 3 Nov 2026 (owner approved): Wi-Fi and mobile data
   disabled over adb (`svc wifi disable`, `svc data disable`; ping 8.8.8.8 "Network is
   unreachable"). Claude Listen heard "What's my battery" exactly, shown as soon as the owner
   stopped speaking. The bridge call then failed as expected (placeholder token, and no network
   for Claude). Network restored to its prior state (Wi-Fi on, data on, airplane off; online
   within about 3 s).
