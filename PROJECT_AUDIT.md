# VFC Project Audit — Organization, Code, Security, Cryptography

**Repository:** MaestroNero/VFC- (public)
**Branch (audit):** `docs/audit-organization-documentation`
**Base:** `main` @ `7305db8` — "Add video processing module for VFC with frame extraction and audio handling"
**Date (UTC):** 2026-09-13
**Scope:** documentation + organization + audit only. No cipher / KDF / payload / stego algorithm changes. No push, no merge, no deletion.
**Verification:** `python3 vfc/tests.py` → **13/13 PASS** on Python 3.13.12; `ffmpeg` **not present** in audit env; `cv2 5.0.0.93` present; `tkinter` importable.

> Finding format used throughout: `ID / Category / Severity / File / Location / Problem / Why it matters / Recommended fix / Risk`.

Severity: **Critical** = exploitable break or data-loss by default · **High** = blocks trust/repro/use or misrepresents security · **Medium** = real bug/design/debt needing plan · **Low** = polish, edge case, or already-documented trade-off.

**Counts:** Critical **0** · High **8** · Medium **15** · Low **12** · Positives noted separately (things done well — do not "fix").

---

## 1. Executive Summary

VFC v0.2 is a coherent, honestly-documented **educational** system. The in-code threat model is unusually candid (fingerprint is public, password is the only secret, custom cipher makes no AES claim), the decrypt path **fails closed** (magic → length → full-HMAC → decrypt, all generic errors, constant-time compares), and the LSB-invariance trick (`abs(s>>1)>=2`) is correct. The 13-check suite passes.

What is not ready: **packaging and repo hygiene** (no `requirements.txt`/`pyproject.toml`, no root `.gitignore`, no `LICENSE`, tracked `__pycache__`), **one security misstatement** (GUI Spec tab says "10 rounds", code is `ROUNDS = 6`), **opaque video failures** (`ffmpeg` stderr discarded), **robustness gaps** in `_unpack_plaintext` (wrong exception types, no bounds checks), **untested video/CLI layers**, and **performance ceilings** (full-WAV in RAM, SHA256-per-swap shuffle). Nothing here requires an algorithm redesign today — it requires hygiene, packaging, tests, and error surfacing first.

**Do first:** untrack `__pycache__` + root `.gitignore`, add `requirements.txt` + minimal `pyproject.toml`, decide `LICENSE`, fix GUI rounds text, surface ffmpeg errors, add bounds checks + version gate in `core`/`payload`. **Do not touch:** SPN rounds/SBox/MDS, PBKDF2 structure, payload wire format, LSB rule — until Phase D crypto-agility is reviewed.

---

## 2. Current Architecture

Verified data flows (not README claims):

```text
ENCRYPT
carrier.mkv --cv2--> frame[N] grayscale list --fingerprint.py--> 8-byte aHash
password + aHash + frame_no --keys.py PBKDF2x3--> K_embed | K_enc K_auth (+16B salt)
secret file --core._pack_plaintext--> [u16 name_len||name||u64 size||u8 flags||data] --zlib-9 iff smaller--> PKCS#7
  --cipher.py SPN-6 CBC (IV random)--> ciphertext --payload.build--> 50B header||ct||32B HMAC
carrier.mkv --ffmpeg demux--> PCM WAV --stego.eligible--> Fisher-Yates(SHA256(K_embed||ctr)) --> LSB replace
  --ffmpeg mux (-c:v copy + pcm_s16le)--> stego.mkv
```

```text
DECRYPT
stego.mkv --cv2--> frame[N] --> aHash --> K_embed --> positions --> 50B header
  --> magic compare_digest --> ct_len guard (<=64MiB, %16==0) --> full extract
  --> HMAC verify (K_auth from header salt) --> CBC decrypt --> unpad --> basename + bytes --> out_dir/
```

Module responsibilities and one-way dependency (`core` never imports `video`/`gui`/`cli`) are described in `README.md` § Architecture. Key constants verified: `ROUNDS=6` (`cipher.py:181`), `PBKDF2_ITERATIONS=200_000` (`keys.py:35`), `HEADER_LEN=50/TAG_LEN=32/VERSION=2` (`payload.py:29-32`), `THRESHOLD=2` (`stego.py:21`), `MAX_CIPHERTEXT=64MiB` (`core.py:24`), `GRID=32/BLOCKS=8` (`fingerprint.py:17-18`).

---

## 3. Repository Structure Review

Good: `vfc/` core separated from `video.py` wrapper, `academic-kit/` isolated, `generate_vfc_trace.py` as single trace source, `vfc_gui.py` thin launcher.

Not good: packaging files absent, bytecode tracked, tests flat, GUI monolithic, absolute dev paths in docs/generator.

| ID | Severity | File | Location | Problem | Why it matters | Recommended fix | Risk |
|---|---|---|---|---|---|---|---|
| ORG-001 | Medium | `vfc/__pycache__/*.pyc` | `git ls-files` shows 11× `cpython-314.pyc` tracked | Build artifacts committed | Noise, churn, stale-bytecode confusion, binary bloat | `git rm -r --cached vfc/__pycache__` + root `.gitignore` (`__pycache__/`, `*.pyc`, `.venv/`, `decrypted/`, `/tmp/`) | Low; one-time history rewrite not needed |
| ORG-002 | Medium | (root) | `ls -a` — no `.gitignore` (only `academic-kit/.gitignore`) | Root hygiene missing | Every `python3` run recreates untracked `cpython-313.pyc` (9 files observed) | Add root `.gitignore` on this branch | Low |
| ORG-003 | High | (root) | glob for `requirements*.txt/pyproject.toml/setup.py` → none | No dependency declaration or project metadata | New clone cannot reproducibly install; version drift (cv2 5.x vs 4.x) | Add `requirements.txt` (`opencv-python-headless`) + minimal `pyproject.toml` (name, version 0.2, requires-python, scripts) | High for DX/repro; no runtime change |
| ORG-004 | Low | `academic-kit/public/media/carrier_video.mp4` (7.1M), `exports/*.pdf` (555K) | `ls -lh` | Large binaries in git | Clone weight; no LFS | Keep for teaching, but document; consider `academic-kit/public/media/README` + LFS later | Low |
| ORG-005 | Medium | `vfc/tests.py` (254 lines) | whole file | Flat ad-hoc suite, not `tests/` + pytest | Hard to run subsets, no fixtures, no CI integration | Migrate to `tests/test_*.py` (keep `vfc/tests.py` as shim one release) | Medium effort; no behavior change |
| ORG-006 | Medium | `vfc/gui.py` | 1682 lines, `VfcGuiApp(tk.Tk)` god-class | 4 tabs + preview + workers + ffmpeg + inspector in one file | Review/merge risk, untestable | Split: `gui/app.py`, `gui/encrypt_tab.py`, `gui/decrypt_tab.py`, `gui/tools_tab.py`, `gui/widgets.py` (Phase B) | Medium; pure move |
| ORG-007 | Low | `vfc/vfc_cli.py:23-31`, `vfc/gui.py:22-25`, `vfc_gui.py:14-24` | `sys.path.insert` + `.venv` `execv` triplicated | Fragile launcher hack | Breaks zipapp/frozen builds, surprising re-exec | Centralize in one `vfc/__main__.py`; document `.venv` expectation | Low |
| ORG-008 | Medium | `generate_vfc_trace.py:38`, `write_typescript:735`, `academic-kit/README_AR.md:10` | `/home/mobta/...` absolute paths | Non-portable defaults | Fresh clone + `--help` confusion; generated-file header points at author machine | Default output to `academic-kit/src/data/vfc-trace.ts` relative to repo root; relative `cd` docs | Low |

---

## 4. Code Quality Findings

| ID | Severity | File | Location | Problem | Why it matters | Recommended fix | Risk |
|---|---|---|---|---|---|---|---|
| CODE-001 | Medium | `vfc/core.py` | `_unpack_plaintext:49-64` | No bounds checks; `.decode("utf-8")` can raise `UnicodeDecodeError`, short slices cause `IndexError` — neither is `ValueError` | `decrypt()` contract says "Raises ValueError", CLI catches only `ValueError/RuntimeError` (`vfc_cli.py:87`) → traceback leak on crafted payload (post-HMAC only, so needs correct password, but still crashes GUI worker generically) | Validate `len(plain)>=2+name_len+8+1` first; wrap decode in `try/except (UnicodeDecodeError, IndexError) → ValueError("invalid filename/size in payload")`; add tests | Auth-bypass: none (post-HMAC). Robustness: real |
| CODE-002 | Low | `vfc/core.py` | `_pack_plaintext:41` `len(name).to_bytes(2,"big")` | Filename > 65535 bytes raises `OverflowError` (uncaught) | Long/unicode filenames crash encrypt with confusing error | Pre-check `if len(name)>65535 or not name: raise ValueError(...)` | Low |
| CODE-003 | Medium | `vfc/core.py:145-207` + `vfc/payload.py:52-64` | `hdr["version"]`, `hdr["flags"]`, `hdr["frame_no"]` parsed but never gated | `VERSION=2` wire field is HMAC-covered but silently ignored; future v3 payload attempted as v2; header `frame_no` vs requested `frame_no` mismatch never surfaced explicitly | Upgrade/misuse confusion; debugging wrong-frame cases harder | `if hdr["version"]!=VERSION: raise ValueError("unsupported payload version")`; log/warn if `hdr["frame_no"]!=frame_no` (keys already bind it — message only) | Low; HMAC already prevents forgery |
| CODE-004 | Low | `vfc/core.py:95-99` | 64 MiB ceiling checked **after** `cbc_encrypt` | Oversize secret pays full encrypt + PBKDF2×3 before rejection | Waste on GUI thread; confusing progress (fails at 42%) | Pre-estimate `len(pkcs7(_pack_plaintext))` upper bound before encrypt, or document as known waste | Low |
| CODE-005 | Low | `vfc/vfc_cli.py:80-85` | `encrypt` path has no `try/except`; `decrypt` does | Encrypt I/O errors (missing carrier, no audio, bad frame) dump traceback | UX + info leak (absolute paths) | Wrap both subcommands; print `FAILED: <msg>` to stderr, exit 2; keep traceback behind `--verbose` | Low |
| CODE-006 | Medium | `vfc/video.py:23-25`, `vfc/gui.py:1631` | `_run()` → `DEVNULL` for stdout+stderr | ffmpeg failures (no audio track, bad codec, missing binary) surface as bare `CalledProcessError`/generic message | #1 DX complaint path; reporter cannot diagnose | Capture `stderr=subprocess.PIPE, text=True`; re-raise `RuntimeError(f"ffmpeg: {stderr[-2000:]}")`; map `FileNotFoundError` → "install ffmpeg" | Low; no behavior change on success |
| CODE-007 | Low | `vfc/video.py`, `vfc/demo_video.py`, `vfc/tests.py` | Missing type hints, `__import__("math")` inline (`tests.py:38`), `sys.argv` at import (`demo_video.py:18`) | Style/testability drag | Minor; slows review | Add `from __future__ import annotations` + hints on public fns; move demo constants into `main()` | Low |
| CODE-008 | Low | `vfc/gui.py:106,1125` | `_preview_cache` unbounded `(path,frame)→PhotoImage` | Scrubbing slider over long video grows RAM | Long sessions bloat | `functools.lru_cache(maxsize=32)` or manual eviction | Low |
| CODE-009 | Low | `vfc/video.py`, `vfc/gui.py` | `subprocess.run` without `timeout` | Hung ffmpeg hangs worker forever | Rare | `timeout=300` + `TimeoutExpired` → friendly error | Low |

What is **good** (do not regress): `os.path.basename` filename sanitization (`core.py:52`), `TemporaryDirectory` WAV staging (`video.py:69,109`), list-form subprocess (no `shell=True`), `compare_digest` everywhere auth-related, Encrypt-then-MAC with verify-before-decrypt, `eligible_indices` LSB-invariance documented + tested (`generate_vfc_trace.py:318` asserts invariance).

---

## 5. Security Findings

Non-crypto application security. Cipher-specific issues live in §6.

| ID | Severity | File | Location | Problem | Why it matters | Recommended fix | Risk |
|---|---|---|---|---|---|---|---|
| SEC-001 | Medium | `vfc/gui.py:1296-1298` | Empty password allowed with yes/no confirm | Zero-entropy KDF; PBKDF2 on `b""` still deterministic → brute-force trivial | Student demo footgun | Default-deny empty; require ≥8 chars or explicit "demo mode" checkbox; add `getpass` strength hint in CLI | Low friction; teaching-safe |
| SEC-002 | Low | `vfc/keys.py:38-46`, `vfc/vfc_cli.py:40`, `vfc/gui.py:1311` | No Unicode normalization (NFKC) before `.encode("utf-8")` | Visually identical passwords (`é` composed vs decomposed) derive different keys → unrecoverable payload | Cross-OS (macOS NFD vs Linux NFC) real | `unicodedata.normalize("NFKC", pw_str).encode()` in one helper shared by CLI+GUI | Low; document change as v0.3 behavior note |
| SEC-003 | Low (info) | `vfc/vfc_cli.py:36-40` | `VFC_PASSWORD` in environment | Env leaks via `/proc`, shell history (`export`), CI logs | Standard CLI practice, but users should know | Document: prefer prompt; `read -s` + unset; never `export` in shared shells; consider `--password-file` (0600) later | Info |
| SEC-004 | Low | `vfc/gui.py:32-62` | `Popen(["xdg-open"/"open", target])` with GUI-chosen path | No shell injection (list form — good), but leading-dash paths could parse as flags on some helpers | Negligible | `Popen(["xdg-open","--",target])` where supported; validate `os.path.exists` (already done) | Negligible |
| SEC-005 | Medium | `vfc/core.py` (via CODE-001) | Post-decrypt errors raise `UnicodeDecodeError`/`IndexError`/`zlib.error`/`ValueError("invalid padding")` distinctly | After HMAC passes (correct password required), error strings could theoretically distinguish corrupt-plaintext causes | Not a password oracle (unreachable without key), but breaks "generic failure" promise | Normalize all post-HMAC unpack failures to `ValueError("payload unpack failed")` (keep detail in debug log only) | Low |
| SEC-006 | Low (intentional) | `vfc/core.py:114-118,124`, `vfc/stego.py:84-97` | `--force`/`force=True` truncates ciphertext+tag | By design demonstrates auth failure; if misunderstood, user ships undecryptable video | Already guarded (default off, GUI warns, decrypt fails closed) | Keep; rename CLI flag help to `--force-truncate-demo`, require confirmation | None when default |
| SEC-007 | Medium | §CODE-006 | Suppressed ffmpeg stderr | User cannot distinguish "no audio" vs "wrong codec" vs "ffmpeg missing" → retries with wrong fixes, may publish broken carrier | DX + support load | Same fix as CODE-006 | Low |

No finding: command injection (no `shell=True` anywhere — `video.py:24`, `gui.py:1577-1583`), path traversal on decrypt write (basename applied before `os.path.join(out_dir, filename)` — `core.py:52` + `video.py:129`), salt/IV reuse (fresh `os.urandom(16)` per encrypt — `core.py:78-79`).

---

## 6. Cryptography Findings

Read `vfc/cipher.py` (256 lines), `vfc/keys.py` (81), `vfc/payload.py` (81) in full. Tests re-run green, but green tests ≠ secure cipher.

| ID | Severity | File | Location | Problem | Why it matters | Recommended fix | Risk |
|---|---|---|---|---|---|---|---|
| CRY-001 | High | `vfc/cipher.py:18,181-193` | Custom SPN-128, **6 rounds**, deterministic SBox, SHA256-derived round keys. No cryptanalysis, no peer review | Must never be presented as production encryption; 6 rounds is AES-subset margin chosen for speed/teaching, not reviewed strength | Keep for teaching; add standard-cipher backend (AES-GCM/ChaCha20-Poly1305) behind `VERSION=3` in Phase D; never raise round count silently (changes wire compat) | Misuse as real secrecy if disclaimers ignored |
| CRY-002 | Low (design OK) | `vfc/cipher.py:87-125` | SBox fixed public permutation (seed `VFC-SBOX-v0.2`), MDS fixed | Correct: SBox is a public parameter like AES's; secrecy lives in round keys | No change; keep seed pinned + bijectivity test | None |
| CRY-003 | Medium | `vfc/keys.py:62-72` | Round keys `SHA256(K_enc\|\|"VFC-RK"\|\|BE16(i))[:16]` — ad-hoc key schedule | No related-key analysis; truncation to 16 B per round; slide-attack rationale stated but unproven | Acceptable for v0.2 teaching; any change → new `VERSION` + vectors; prefer HKDF-SHA256 with distinct `info` in Phase D | Low today (teaching); High if productionized |
| CRY-004 | Medium | `vfc/fingerprint.py:17-58` | Only **64-bit** aHash; median-thresholded; nearest-neighbor resize | Collisions and near-duplicate frames realistic; binding strength ≪ password strength (code comments admit this — good) | Keep binding semantics; document collision expectation; consider 128-bit perceptual hash only as *additional* diversification in future version | Weak binding if carrier attacker can find colliding frame |
| CRY-005 | Medium (documented trade-off) | `vfc/keys.py:1-16,43-46` | `K_embed` derived **without salt** (circular-dependency fix) | Enables payload location pre-salt; costs attacker one PBKDF2 per guess — same as any check — so no *cheap* oracle (comment + magic design correct). Still: salt benefit absent for embedding positions | Keep; do not "fix" by adding salt (would break decrypt bootstrap). Note in docs (done in README Security Model) | Low given 200k iterations |
| CRY-006 | Low | `vfc/keys.py:35,38-40` | PBKDF2-HMAC-SHA256 200k, CPU-only, fixed count | No memory-hardness (Argon2id/scrypt); count not tunable; 3× PBKDF2 per encrypt (~600k hashes) + 2× per decrypt | Fine for education; expose `VFC_PBKDF2_ITERATIONS` override + calibration in Phase C; migrate option in Phase D | Offline brute force bounded by password entropy |
| CRY-007 | High | `vfc/gui.py:981` | Spec tab text: "AddRoundKey across **10 rounds**" | Code is `ROUNDS = 6` (`cipher.py:181`). Security-relevant misstatement in shipped UI | One-line fix to `f"{ROUNDS} rounds"` dynamic string + test asserting GUI text matches `cipher.ROUNDS` | Misinformed classroom/demo claims |
| CRY-008 | Positive | `vfc/payload.py:35-49,71-81` + `vfc/core.py:188-199` | Encrypt-then-MAC, HMAC covers header+ciphertext, verify-before-decrypt, generic errors | Correct order; IV/salt tampering fails auth; no padding-oracle channel (CBC unpad only after HMAC) | Preserve exactly; add negative tests pinning order | — |
| CRY-009 | Positive | `vfc/keys.py:79-81`, `vfc/core.py:170,178` | `constant_time_eq` (`hmac.compare_digest`) for magic + tag | No timing oracle on password/frame guess | Preserve; never replace with `==` | — |

KDF parameter sync risk is tracked as DEP-006 (TS mirror must match `200_000` manually).

---

## 7. Steganography Findings

| ID | Severity | File | Location | Problem | Why it matters | Recommended fix | Risk |
|---|---|---|---|---|---|---|---|
| STEG-001 | Medium (by design) | `vfc/stego.py:84-97` + docstring `:14-15` | LSB **replacement** (not matching ±1) | Replacement creates textbook-detectable pairs-of-values asymmetry; χ²-uniformity test in suite is a smoke check, not undetectability proof | Document as teaching choice (done); offer LSB-matching as Phase E research option; never claim covertness | Detection by standard steganalysis |
| STEG-002 | Medium (by design) | `vfc/video.py:49-53` | Payload survives only with `pcm_s16le` remux; any AAC/MP3/Opus/resample/transcode destroys LSBs | Users uploading stego to recompressing platforms lose data silently (decrypt then fails auth — safe, but surprising) | Keep fail-closed; add pre-share warning in CLI/GUI + `--check` that re-demuxes and verifies before sharing | Data loss by user workflow, not by bug |
| STEG-003 | Low | `vfc/gui.py:1638` | Inspector `overhead = 146` rough constant | Real overhead = 50 header + 32 tag + PKCS#7 (1–16) + zlib delta + filename framing; estimate drifts | Compute `payload_overhead(secret_len, filename)` helper shared by core+GUI; label as estimate | Mis-sized secrets near capacity edge |
| STEG-004 | Low | `vfc/stego.py:21,49-50` | `THRESHOLD=2` fixed silence gate | Very quiet/very loud carriers get uniform gate; no perceptual model | Fine for v0.2; expose constant + calibration note in Phase E | Suboptimal capacity/quality trade |

Correct and kept: eligibility invariance via `s>>1` (docstring + `generate_vfc_trace.py:318` assert), MSB-first bit order both directions, unique positions via full shuffle, capacity pre-check with `force` escape hatch.

---

## 8. Dependency Findings

Actual runtime deps (from imports + subprocess): **stdlib** (`hashlib, hmac, wave, array, statistics, zlib, os, subprocess, tempfile, argparse, getpass, tkinter, threading`) + **`cv2` (opencv)** + **`ffmpeg` binary**. `numpy`/`cryptography` are **not** direct deps.

| ID | Severity | File | Location | Problem | Why it matters | Recommended fix | Risk |
|---|---|---|---|---|---|---|---|
| DEP-001 | High | (root) | no manifest | Missing `requirements.txt`/`pyproject.toml` | §ORG-003 | Same fix | Repro failure |
| DEP-002 | Medium | `vfc/video.py:30`, `vfc/gui.py:20` | `cv2` unpinned, `numpy` transitive-only | OpenCV 4→5 decode differences could shift frame bytes → fingerprint drift | Pin `opencv-python-headless==5.0.0.93` (audited env) + `numpy==2.2.4` floor; add frame-stability note | Fingerprint mismatch across envs |
| DEP-003 | High | `vfc/video.py:44-53` | `ffmpeg` binary required but undeclared | `FileNotFoundError`/cryptic fail on fresh machines (audit env itself lacks ffmpeg) | Declare in README (done) + `requirements-system.txt`/docs + startup check `shutil.which("ffmpeg")` with install hint | Video path entirely broken without it |
| DEP-004 | Info (good) | `vfc/keys.py`, `vfc/payload.py` | `cryptography` package **not** used; stdlib `hashlib`/`hmac` only | Reduces supply-chain surface — correct for teaching | Keep; if AES backend added, prefer `cryptography` wheel over new custom code | — |
| DEP-005 | Positive | `academic-kit/package.json` + `package-lock.json` (45K) | React/Vite/TS pinned via lockfile | Web lab reproducible | Keep lockfile committed; `npm run check` in CI later | — |
| DEP-006 | Medium | `academic-kit/src/lib/vfc-crypto.ts:53-~90` | WebCrypto PBKDF2 `iterations: 200000` hardcoded to mirror `keys.py:35` | Silent divergence if Python count changes | Import iteration count from generated trace (`vfc-trace.ts` already carries `iterations`) instead of literal | Teaching-demo key mismatch |

---

## 9. Testing Findings

State: `vfc/tests.py` 13 checks, deterministic seed `VFC-tests-0.2`, **13/13 pass** (audit re-ran). Not pytest; no fixtures; no video/CLI coverage.

| ID | Severity | File | Location | Problem | Why it matters | Recommended fix | Risk |
|---|---|---|---|---|---|---|---|
| TEST-001 | Medium | `vfc/tests.py` | whole file | Monolithic script, `print`-based, `sys.exit` code only | No selective run, no junit, no coverage | `tests/test_cipher.py test_keys.py test_payload.py test_fingerprint.py test_stego.py test_video.py test_cli.py` + keep shim | Medium effort |
| TEST-002 | Medium | (missing) | `vfc/video.py` 135 lines, zero tests | Demux/mux/frame path (highest real-world fragility) untested | Frame-drift, no-audio, missing-ffmpeg regressions invisible | `test_video.py` with mocked `_run` + tiny generated MKV fixture (ffmpeg-gated `pytest.mark`) | High value |
| TEST-003 | Medium | (missing) | `vfc/vfc_cli.py`, `vfc/gui.py` workers | CLI exit codes, `VFC_PASSWORD` prompt path, progress callbacks untested | Regression on UX-affecting errors | `test_cli.py` via `CliRunner`-style subprocess + env isolation | Low effort |
| TEST-004 | Medium | (missing) | edge matrix | No empty-file, 0-sample-audio, oversize (>64MiB claim), unicode/long filename, corrupted-header, truncated-payload, no-audio-video, frame-out-of-range cases | CODE-001/002/003 would have been caught | Add negative/corruption matrix (parametrized) | Medium effort, high value |
| TEST-005 | Low | `vfc/tests.py:43-46,193-196` | Synthetic `0x9E37` PCM only; SNR asserted on synthetic carrier | Real recorder/YouTube PCM behaves differently (silence ratio, DC offset) | Add 1-sec real-WAV fixture (libri-free, generated via ffmpeg sine) + same SNR gate | Lab-vs-field gap |
| TEST-006 | Positive | `vfc/tests.py:80-115,169-184` | Avalanche band (46–54%), 16/16 diffusion, single-bit-flip rejection | Good property tests for teaching claims | Keep thresholds; add seed-varied nightly run | — |

---

## 10. Documentation Findings

| ID | Severity | File | Location | Problem | Why it matters | Recommended fix | Risk |
|---|---|---|---|---|---|---|---|
| DOC-001 | Medium (fixed this branch) | `README.md` (pre-audit, 94 lines, Arabic-only brief) | Minimal install/usage, no arch/security/limits/license | First-time clone could not evaluate or run safely | Rewritten professional README on this branch (verify diff before merge) | None post-merge |
| DOC-002 | High | `vfc/gui.py:976-986` | "across 10 rounds" (§CRY-007) | Security-relevant inaccuracy in shipped UI | Same fix as CRY-007 | Classroom misinformation |
| DOC-003 | High | (root) | No `LICENSE` | Default all-rights-reserved; reuse/fork legality unclear; GitHub license detection empty | Maintainer must add license (MIT/CC-BY choice is theirs — not added in audit) + `README` note (done, states absence) | Contribution/legal block |
| DOC-004 | Low | `academic-kit/README_AR.md:10` | `cd /home/mobta/university/Crypto/academic-kit` | Copy-paste fails elsewhere | `cd academic-kit` | Low |
| DOC-005 | Low | `generate_vfc_trace.py:38,735` | Default output + file header embed `/home/mobta/...` | Generated `vfc-trace.ts` header references author machine (cosmetic, already in committed trace) | Relative default + neutral header (`generated by generate_vfc_trace.py`) | Cosmetic |
| DOC-006 | Low | `vfc/video.py:23-53` | `_run/_demux/_mux` undocumented failure modes | Contributor cannot predict errors | Docstrings + raised-error contracts | Low |

`academic-kit/` docs (`README.md`, `README_AR.md`, `PRODUCT.md`, `DESIGN.md`) are above-average for a teaching repo — scope, honesty note, and trace-regeneration contract are explicit. Keep.

---

## 11. Performance Findings

| ID | Severity | File | Location | Problem | Why it matters | Recommended fix | Risk |
|---|---|---|---|---|---|---|---|
| PERF-001 | Medium | `vfc/stego.py:33-48` | Full WAV into `array('h')` + `eligible_indices()` full list + shuffled copy (3× sample-count memory) | Hour-long 48 kHz stereo ≈ 350M samples → GBs RAM, OOM | Streaming windowed embed/extract + `array('h')` mmap path in Phase C; document "short carriers only" meanwhile | OOM on large carriers |
| PERF-002 | Medium | `vfc/prng.py:59-68` + `KeyStream:29-56` | Fisher-Yates over **all** eligible samples, one SHA256-block per ~32 swaps (worst case millions of hashes) | Minutes-long GUI freeze on large audio despite progress bar | Shuffle lazily (partial Fisher-Yates / format-preserving selection of first `need_bits`), or SHAKE128 stream; benchmark on 10-min fixture | UX + battery |
| PERF-003 | Low | `vfc/core.py:105,152` | `eligible` list copied inside `shuffled_positions` (`idx = list(eligible)`) | 2× peak list memory | Shuffle indices in place or return iterator | Low |
| PERF-004 | Low | §CODE-004 | Post-encrypt size gate wastes CBC work | Same fix | Minor CPU | Low |
| PERF-005 | Info | `vfc/keys.py` | 3× PBKDF2(200k) encrypt, 2×+1 magic decrypt (~0.3–1 s each on laptop) | Expected; GUI already threads workers (good) | Keep; add calibration + `VFC_PBKDF2_ITERATIONS` escape hatch for tests (fast KDF in unit tests via monkeypatch) | Test-suite speed |

No premature optimization applied in audit (per instructions).

---

## 12. Developer Experience Findings

Fresh-clone walkthrough (audit env): clone → `pip install opencv-python-headless` (undocumented) → `python3 vfc/tests.py` ✅ → `ffmpeg`-dependent paths ❌ (`ffmpeg not found`) → GUI needs display + `python3-tk` on minimal images → academic-kit needs `npm install` (documented ✅).

| ID | Severity | File | Location | Problem | Why it matters | Recommended fix | Risk |
|---|---|---|---|---|---|---|---|
| DX-001 | High | (root) | No install manifest (§ORG-003/DEP-001) | Trial-and-error setup | Same packaging fix | New-user abandonment |
| DX-002 | Medium | `vfc/video.py` | Missing-ffmpeg / no-audio errors cryptic (§CODE-006) | Same error-surface fix + `shutil.which` preflight + `--check-carrier` | Support load |
| DX-003 | Low | (missing) | No `--estimate` dry run | User discovers capacity failure after minutes of PBKDF2+encrypt | `encrypt --dry-run` printing `need_bits/have_bits/capacity_pct` without embedding | UX |
| DX-004 | Low | (missing) | Human-only stats print | Scripting/CI cannot consume capacity/result | `--json` flag emitting stats dict (already built in `core.encrypt` return) | Automation |
| DX-005 | Low | `vfc/vfc_cli.py:26-31` | `.venv` re-exec assumes `<root>/.venv/bin/python` | Breaks conda/poetry/system installs subtly | Try import first (already), else clear "install opencv" message instead of silent exec | Confusion |

---

## 13. Critical Issues

**None found.** No remote-code-execution, no shell injection, no authentication bypass, no silent decrypt corruption (HMAC gate holds in all tamper tests D/F + suite bit-flip test). This section is intentionally empty rather than inflated.

---

## 14. High Priority Issues

1. **ORG-003 / DEP-001 / DX-001** — No `requirements.txt` / `pyproject.toml`; reproducible install impossible.
2. **DEP-003** — `ffmpeg` binary required but undeclared and unchecked at startup.
3. **CRY-001** — Custom SPN-6 must stay labeled educational; needs standard-cipher option before any production-adjacent use.
4. **CRY-007 / DOC-002** — GUI "10 rounds" contradicts `ROUNDS = 6`.
5. **DOC-003** — No `LICENSE` file.

---

## 15. Medium Priority Issues

ORG-001, ORG-002, ORG-005, ORG-006, ORG-008 · CODE-001, CODE-003, CODE-006 · SEC-001, SEC-005, SEC-007 · CRY-003, CRY-004, CRY-005 · STEG-001, STEG-002 · DEP-002, DEP-006 · TEST-001–004 · DOC-001 · PERF-001, PERF-002 · DX-002. (Details in §§3–12; roadmap mapping in §21.)

---

## 16. Low Priority Issues

ORG-004, ORG-007 · CODE-002, CODE-004, CODE-005, CODE-007–009 · SEC-002–004, SEC-006 · CRY-002, CRY-006 · STEG-003, STEG-004 · TEST-005 · DOC-004–006 · PERF-003, PERF-004 · DX-003–005.

---

## 17. Recommended Refactoring

Ordered, behavior-preserving unless noted:

1. **Hygiene (this branch, safe):** root `.gitignore`; `git rm --cached vfc/__pycache__`; `requirements.txt` + `pyproject.toml`; fix GUI rounds string to use `cipher.ROUNDS`; relative trace default; relative `cd` docs. No logic change.
2. **Error surfacing:** `video._run` captures stderr + maps `FileNotFoundError`; CLI wraps `encrypt`; GUI worker already threads — reuse new error types. No format change.
3. **Robustness (tiny logic, needs tests first):** `_unpack_plaintext` bounds + exception normalization; `VERSION` gate; filename-length pre-check; normalize post-HMAC errors. Wire format unchanged.
4. **Structure (Phase B):** split `gui.py` by tab; introduce `vfc/__main__.py`; move tests to `tests/` with shim. No algorithm change.
5. **Performance (Phase C, measured):** streaming WAV I/O; partial shuffle; KDF-iteration override for tests. Benchmark fixtures before/after.
6. **Crypto agility (Phase D, reviewed):** `VERSION=3` AES-GCM/ChaCha20 backend alongside SPN `VERSION=2`; HKDF key schedule; NFKC passwords. Requires reviewer sign-off + vectors + migration tests. **Not in this branch.**

---

## 18. Recommended New Tests

```
tests/
├── test_cipher.py      # vectors: roundtrip, padding edge (0/15/16B), MDS identity, SBox inverse, wrong-key decrypt != plaintext
├── test_keys.py        # domain separation (EMBED≠ENCRYPT≠AUTH), salt sensitivity, magic determinism, iteration-count pin
├── test_payload.py     # build→read→verify roundtrip; tamper each header byte; ct_len odd/%16/>64MiB; version-gate; flags reserved
├── test_fingerprint.py # determinism, 8-byte length, distinct frames differ, resize edge (1px, non-square)
├── test_stego.py       # eligibility invariance after embed, capacity math, force-truncate, empty payload, MSB-first order
├── test_core.py        # pack/unpack: empty, unicode/long filename, incompressible data, compress-no-gain path, MAX ceiling
├── test_video.py       # mocked ffmpeg: demux-fail, no-audio, frame-out-of-range, mux args assert (-c:v copy + pcm_s16le)
├── test_cli.py         # encrypt/decrypt exit codes, VFC_PASSWORD vs prompt (mock getpass), --force, wrong-frame/password
└── test_e2e.py         # tiny generated MKV (ffmpeg-gated): encrypt→decrypt match; wrong pw/frame fail; recompress destroys (expected fail)
```

Plus: GUI rounds-text sync test (`assert str(cipher.ROUNDS) in spec_text`), trace-regeneration test (`generate_vfc_trace --check` compares `sourceSha256`), and negative-message test (all decrypt failures match `authentication failed|unsupported version|payload unpack failed`).

---

## 19. Recommended Documentation

- [x] Professional `README.md` (this branch) — verify diff, then merge.
- [ ] One-line GUI rounds fix + screenshot refresh if docs embed UI text.
- [ ] `LICENSE` decision (maintainer action; auditor does not choose).
- [ ] `academic-kit/README_AR.md` relative path; generator neutral header/relative default.
- [ ] `docs/CARRIER.md` (MKV/PCM preparation, `-c:v copy` rationale, no-recompress warning) + `docs/CAPACITY.md` (exact overhead formula replacing `146`).
- [ ] `docs/THREAT_MODEL.md` (attacker-has-video assumption, PBKDF2-only secret, detectability, non-goals) — README summarizes; full doc for classroom.
- [ ] Docstrings for `video._run/_demux/_mux` error contracts.

---

## 20. Proposed Future Architecture

Keep the layer diagram; swap primitives behind versioned headers, not by editing v0.2 in place:

```text
vfc/
├── core.py            # version-dispatched orchestration (v2 SPN / v3 AEAD)
├── cipher_spn.py       # today's cipher.py, frozen for teaching
├── cipher_aead.py      # NEW: AES-GCM + ChaCha20-Poly1305 via `cryptography` (Phase D)
├── keys.py            # + HKDF option, NFKC helper, tunable iterations
├── payload.py         # VERSION dispatch (2=legacy, 3=AEAD+nonce), strict gate
├── stego.py           # + LSB-matching backend + streaming I/O
├── video.py           # + preflight checks, --check-carrier, stderr propagation
└── tests/             # pytest, fixtures, e2e (ffmpeg-gated)
```

`academic-kit/` continues to pin and visualize **both** versions via regenerated traces; `vfc-trace.ts` gains `version` field. GUI gains backend selector (default: teaching SPN with banner; recommended: AEAD).

---

## 21. Suggested Roadmap

| Priority | Problem | Impact | Effort | Recommended solution | Dependencies |
|---|---|---|---|---|---|
| P0 | Unreproducible install (ORG-003/DEP-001/DX-001) | New users blocked | S | `requirements.txt` + `pyproject.toml` + README install (this branch) | None |
| P0 | Tracked bytecode + no gitignore (ORG-001/002) | Repo noise, confusion | XS | Untrack + `.gitignore` (this branch) | None |
| P0 | GUI "10 rounds" falsehood (CRY-007) | Security misrepresentation | XS | Dynamic `ROUNDS` string (this branch + test) | None |
| P0 | Opaque ffmpeg failures (CODE-006/DX-002/DEP-003) | Video path undebuggable | S | Stderr propagation + `which` preflight | None |
| P1 | `_unpack` robustness + version gate (CODE-001/003/SEC-005) | Crashes, upgrade hazard | S | Bounds checks + normalized errors + gate + tests | TEST-004 |
| P1 | No LICENSE (DOC-003) | Legal block | XS (decision) | Maintainer chooses + adds | None |
| P1 | Untested video/CLI (TEST-002/003) | Silent regression | M | Mocked `test_video` + `test_cli` | Packaging |
| P1 | Empty password (SEC-001) | Footgun | XS | Default-deny + hint | None |
| P2 | Structure: split GUI, `__main__`, `tests/` (ORG-005/006/007) | Maintainability | M | Pure moves + shim | P0 done |
| P2 | Perf: streaming WAV + partial shuffle (PERF-001/002) | Large carriers | M | Benchmark → implement → gate | Tests |
| P2 | Docs: CARRIER/CAPACITY/THREAT_MODEL (DOC) | Classroom clarity | S | Three short docs | README merged |
| P3 | Crypto agility v3 (CRY-001/003/006) | Real-secrecy option | L | AEAD backend + vectors + review | All above + explicit approval |
| P3 | Stego research (STEG-001/004) | Robustness study | L | LSB-matching + perceptual notes | Perf done |
| P3 | DX: `--estimate`, `--json`, timeouts (DX-003/004, CODE-009) | Automation | S | Flags threading existing stats | CLI tests |

**Explicit non-goals for next phase:** changing SPN rounds/SBox/MDS, changing PBKDF2 wire inputs, changing payload layout, changing LSB rule, deleting files, pushing/merging without review.

---

## Appendix — Verification Log (audit)

- `git status` clean on `main`, branched to `docs/audit-organization-documentation` (no push).
- `python3 vfc/tests.py` → 13/13 PASS (output captured in §12 header).
- `rg`/`grep` for `shell=True` → none; for `os.startfile/xdg-open` → list-form only; for `to_bytes(2` → filename framing confirmed.
- `git ls-files | grep pycache` → 11 tracked `.pyc` (finding ORG-001).
- `ffmpeg`/`ffprobe` absent in audit env (finding DEP-003/DX-002 evidence).
- `cipher.ROUNDS == 6` at runtime vs GUI string "10 rounds" (finding CRY-007).
- `hdr["version"]` read in `payload.py:58` but never consumed in `core.py` (finding CODE-003).
- No `requirements/pyproject/LICENSE` by glob (findings ORG-003/DOC-003).
